import { useEffect, useRef } from "react";
import { KittenSpeaker } from "./kitten/kittenSpeaker";
import { decodeRecordedSpeech, LocalSpeechTranscriber } from "./voiceEngines";
import {
  BARGE_IN_MS,
  bargeInThreshold,
  microphoneRms,
  ReadAloudTracker,
  SPEECH_START_MS,
  shouldFinishUtterance,
  speechThreshold,
  transcribeAndSend,
  type SpokenMessage,
} from "./voiceCall.logic";

/** A recording that has not been decided yet: whether it becomes a message or is discarded. */
interface Capture {
  readonly recorder: MediaRecorder;
  readonly chunks: BlobPart[];
  readonly startedAt: number;
  /** Sparky was talking when the capture began, so only sustained speech may interrupt it. */
  readonly interrupting: boolean;
  lastLoudAt: number;
  loudSince: number | null;
  confirmed: boolean;
}

export interface VoiceSessionProps {
  audioContext: AudioContext;
  messages: ReadonlyArray<SpokenMessage>;
  needsAttention: boolean;
  voice: string;
  speed: number;
  onSend: (transcript: string) => Promise<boolean>;
  /** Called once the speech model and microphone are ready and listening has begun. */
  onReady: () => void;
  onError: (message: string) => void;
  onClose: () => void;
}

/**
 * A voice call is a conversation on the chat's own model and tools. The microphone
 * is transcribed on this device and sent as a normal message after 2 seconds of
 * silence; the reply is read aloud with Kitten TTS while it streams. Speaking over
 * Sparky stops the reading and starts the next turn, so the conversation can be
 * steered by voice at any time. The chat itself renders the transcript and reply.
 */
export function VoiceSession({
  audioContext,
  messages,
  needsAttention,
  voice,
  speed,
  onSend,
  onReady,
  onError,
  onClose,
}: VoiceSessionProps) {
  const messagesRef = useRef(messages);
  const needsAttentionRef = useRef(needsAttention);
  const onSendRef = useRef(onSend);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onCloseRef = useRef(onClose);
  const speakerRef = useRef<KittenSpeaker | null>(null);
  const trackerRef = useRef<ReadAloudTracker | null>(null);
  const pauseRef = useRef<(() => void) | null>(null);

  messagesRef.current = messages;
  needsAttentionRef.current = needsAttention;
  onSendRef.current = onSend;
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  onCloseRef.current = onClose;

  useEffect(() => {
    let closed = false;
    let stream: MediaStream | null = null;
    let inputContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let timer: number | undefined;
    let capture: Capture | null = null;
    let transcribing = false;
    let noiseFloor = 0.001;
    let listenStartedAt = 0;
    let loudFrames = 0;
    let transcriber: LocalSpeechTranscriber | null = null;
    const wave = new Float32Array(2048);

    const fail = (error: unknown) => {
      if (closed) return;
      const message = error instanceof Error ? error.message : "Voice could not start.";
      onErrorRef.current(message);
      onCloseRef.current();
    };

    // The speaker needs no microphone, so it starts loading immediately.
    const assetBase = new URL(import.meta.env.BASE_URL, window.location.href).href;
    const speaker = new KittenSpeaker(audioContext, assetBase);
    speakerRef.current = speaker;
    const tracker = new ReadAloudTracker();
    trackerRef.current = tracker;
    tracker.ignoreExisting(messagesRef.current);
    // A reply still streaming when the call starts is not read from its beginning.
    tracker.skipCurrent(messagesRef.current);

    const discard = (current: Capture) => {
      if (capture === current) capture = null;
      if (current.recorder.state === "recording") {
        current.recorder.onstop = null;
        current.recorder.stop();
      }
    };

    const interruptSpeech = () => {
      speaker.stop();
      tracker.skipCurrent(messagesRef.current);
    };

    const startCapture = () => {
      if (typeof MediaRecorder === "undefined" || !stream) {
        fail(new Error("Audio recording is unavailable."));
        return;
      }
      const recorder = new MediaRecorder(stream);
      const current: Capture = {
        recorder,
        chunks: [],
        startedAt: performance.now(),
        lastLoudAt: performance.now(),
        loudSince: null,
        confirmed: false,
        interrupting: speaker.busy,
      };
      capture = current;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) current.chunks.push(event.data);
      };
      recorder.onstop = () => void finishCapture(current);
      try {
        recorder.start(250);
      } catch (error) {
        capture = null;
        fail(error);
      }
    };

    const finishCapture = async (current: Capture) => {
      if (capture === current) capture = null;
      if (closed) return;
      // Sound that never became speech (a click, an echo) is dropped.
      if (!current.confirmed || current.chunks.length === 0) {
        return;
      }
      transcribing = true;
      try {
        const pcm = await decodeRecordedSpeech(new Blob(current.chunks, { type: current.recorder.mimeType }));
        if (closed) return;
        const engine = transcriber;
        if (!engine) throw new Error("Speech recognition is not initialized.");
        const { transcript, sent } = await transcribeAndSend(
          pcm,
          (audio) => engine.transcribe(audio),
          async (text) => {
            if (closed) return false;
            // The reply already on screen was written before this turn; read only what comes next.
            tracker.ignoreExisting(messagesRef.current);
            return onSendRef.current(text);
          },
        );
        if (closed) return;
        if (transcript && !sent) fail(new Error("Sparky could not send your spoken message."));
      } catch (error) {
        fail(error);
      } finally {
        transcribing = false;
      }
    };

    const listen = () => {
      if (closed || !analyser) return;
      const now = performance.now();
      const talking = speaker.busy;
      analyser.getFloatTimeDomainData(wave);
      const rms = microphoneRms(wave);
      if (capture) {
        const current = capture;
        const loud = rms > (talking || current.interrupting ? bargeInThreshold(noiseFloor) : speechThreshold(noiseFloor));
        if (loud) {
          current.loudSince ??= now;
          current.lastLoudAt = now;
        } else {
          current.loudSince = null;
        }
        if (!current.confirmed && current.loudSince !== null) {
          const needed = current.interrupting ? BARGE_IN_MS : SPEECH_START_MS;
          if (now - current.loudSince >= needed) {
            current.confirmed = true;
            if (current.interrupting) interruptSpeech();
          }
        }
        if (!current.confirmed && now - current.startedAt > 2_000) {
          discard(current);
          return;
        }
        if (shouldFinishUtterance(now - current.startedAt, now - current.lastLoudAt, current.confirmed)) {
          if (current.recorder.state === "recording") current.recorder.stop();
          return;
        }
        return;
      }
      if (transcribing || needsAttentionRef.current) return;
      // Learn the room's noise before any turn can start: fast for the first two seconds,
      // then slowly, so steady noise such as a fan is already in the floor.
      const learning = now - listenStartedAt < 2_000;
      if (!talking) noiseFloor = learning ? noiseFloor * 0.9 + rms * 0.1 : noiseFloor * 0.98 + rms * 0.02;
      if (learning) return;
      const threshold = talking ? bargeInThreshold(noiseFloor) : speechThreshold(noiseFloor);
      loudFrames = rms > threshold ? loudFrames + 1 : 0;
      if (loudFrames >= 2) {
        loudFrames = 0;
        startCapture();
      }
    };

    pauseRef.current = () => {
      if (capture) discard(capture);
      interruptSpeech();
    };

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is unavailable.");
        // Only local recognition receives microphone audio. Sparky's model receives text.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (closed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        inputContext = new AudioContext();
        if (inputContext.state === "suspended") await inputContext.resume();
        if (closed) return;
        const source = inputContext.createMediaStreamSource(stream);
        analyser = inputContext.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        transcriber = new LocalSpeechTranscriber(assetBase);
        void Promise.all([speaker.load(), transcriber.load()]).then(() => {
          if (!closed) onReadyRef.current();
        }, fail);
        // A timer, not requestAnimationFrame: frames stop while the window is hidden.
        listenStartedAt = performance.now();
        timer = window.setInterval(listen, 30);
      } catch (error) {
        fail(error);
      }
    })();

    return () => {
      closed = true;
      if (timer !== undefined) window.clearInterval(timer);
      if (capture) discard(capture);
      speakerRef.current = null;
      trackerRef.current = null;
      pauseRef.current = null;
      speaker.dispose();
      transcriber?.dispose();
      stream?.getTracks().forEach((track) => track.stop());
      if (inputContext) void inputContext.close();
    };
  }, [audioContext]);

  // Read the reply aloud as it streams, one sentence at a time, in order.
  useEffect(() => {
    const speaker = speakerRef.current;
    const tracker = trackerRef.current;
    if (!speaker || !tracker || needsAttention) return;
    for (const segment of tracker.advance(messages)) {
      void speaker.speak(segment, voice, speed).catch((error: unknown) => {
        onErrorRef.current(error instanceof Error ? error.message : "Voice playback failed.");
      });
    }
  }, [messages, needsAttention, speed, voice]);

  // Pending approvals stay in the ordinary chat. Pause listening and speech until they are resolved.
  const attentionWasPendingRef = useRef(false);
  useEffect(() => {
    if (needsAttention) {
      attentionWasPendingRef.current = true;
      pauseRef.current?.();
    } else {
      attentionWasPendingRef.current = false;
    }
  }, [needsAttention]);

  return null;
}
