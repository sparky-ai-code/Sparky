import { useEffect, useRef, useState } from "react";
import { decodeRecordedSpeech, LocalSpeechTranscriber, TinyVocaSpeaker } from "./voiceEngines";
import { latestNewAssistant, microphoneRms, shouldFinishUtterance, speechThreshold, textForSpeech, transcribeAndSend } from "./voiceCall.logic";

type Phase = "loading" | "listening" | "recording" | "transcribing" | "waiting" | "speaking" | "paused";

export interface VoiceSessionProps {
  audioContext: AudioContext;
  messages: ReadonlyArray<{ id: string; role: string; text: string; streaming?: boolean }>;
  busy: boolean;
  settled: boolean;
  needsAttention: boolean;
  voice: "F2" | "M2";
  speed: number;
  onSend: (transcript: string) => Promise<boolean>;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

/**
 * Speech is an input/output method for the normal chat, not a separate call UI.
 * The existing chat renders the transcribed user message and assistant answer.
 */
export function VoiceSession({
  audioContext,
  messages,
  busy,
  settled,
  needsAttention,
  voice,
  speed,
  onSend,
  onStatus,
  onError,
  onClose,
}: VoiceSessionProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const phaseRef = useRef<Phase>("loading");
  const closedRef = useRef(false);
  const outputCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needsAttentionRef = useRef(needsAttention);
  const messagesRef = useRef(messages);
  const onSendRef = useRef(onSend);
  const onStatusRef = useRef(onStatus);
  const onErrorRef = useRef(onError);
  const onCloseRef = useRef(onClose);
  const speakerRef = useRef<TinyVocaSpeaker | null>(null);
  const listenRef = useRef<(() => void) | null>(null);
  const cancelRecordingRef = useRef<(() => void) | null>(null);
  const baselineAssistantIdRef = useRef<string | null>(null);

  messagesRef.current = messages;
  needsAttentionRef.current = needsAttention;
  onSendRef.current = onSend;
  onStatusRef.current = onStatus;
  onErrorRef.current = onError;
  onCloseRef.current = onClose;

  const changePhase = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  useEffect(() => {
    // StrictMode may mount, clean up and remount this effect immediately.
    if (outputCloseTimer.current !== null) {
      clearTimeout(outputCloseTimer.current);
      outputCloseTimer.current = null;
    }
    closedRef.current = false;
    let closed = false;
    let stream: MediaStream | null = null;
    let inputContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let frame = 0;
    let recorder: MediaRecorder | null = null;
    let epoch = 0;

    const report = (message: string) => {
      if (!closed) onStatusRef.current(message);
    };
    const fail = (error: unknown) => {
      if (closed) return;
      const message = error instanceof Error ? error.message : "Voice could not start.";
      report(message);
      onErrorRef.current(message);
      onCloseRef.current();
    };
    let speaker: TinyVocaSpeaker | null = null;
    let transcriber: LocalSpeechTranscriber | null = null;

    const cancelRecording = () => {
      epoch += 1;
      window.cancelAnimationFrame(frame);
      if (recorder?.state === "recording") {
        recorder.onstop = null;
        recorder.stop();
      }
      recorder = null;
    };
    cancelRecordingRef.current = cancelRecording;

    const listen = () => {
      if (closed || !stream || !analyser) return;
      if (needsAttentionRef.current) {
        changePhase("paused");
        return;
      }
      if (recorder?.state === "recording") return;
      if (typeof MediaRecorder === "undefined") {
        fail(new Error("Audio recording is unavailable."));
        return;
      }
      const current = new MediaRecorder(stream);
      const thisEpoch = ++epoch;
      recorder = current;
      const chunks: BlobPart[] = [];
      const startedAt = performance.now();
      let speechDetected = false;
      let lastLoudAt = startedAt;
      let noiseFloor = 0.001;
      let loudFrames = 0;
      const wave = new Float32Array(analyser.fftSize);

      current.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      current.onstop = () => {
        window.cancelAnimationFrame(frame);
        if (closed || epoch !== thisEpoch) return;
        recorder = null;
        if (!speechDetected || chunks.length === 0) {
          listen();
          return;
        }
        changePhase("transcribing");
        report("Transcribing…");
        void (async () => {
          try {
            const pcm = await decodeRecordedSpeech(new Blob(chunks, { type: current.mimeType }));
            if (closed || epoch !== thisEpoch) return;
            const engine = transcriber;
            if (!engine) throw new Error("Speech recognition is not initialized.");
            baselineAssistantIdRef.current =
              [...messagesRef.current].reverse().find((item) => item.role === "assistant")?.id ?? null;
            const { transcript, sent } = await transcribeAndSend(
              pcm,
              (audio) => engine.transcribe(audio),
              async (text) => {
                if (closed || epoch !== thisEpoch) return false;
                changePhase("waiting");
                report("Sending spoken message…");
                return onSendRef.current(text);
              },
              () => report("Recognized speech. Sending…"),
            );
            if (closed || epoch !== thisEpoch) return;
            if (!transcript) {
              report("Didn't catch that. Listening…");
              listen();
              return;
            }
            if (!sent) fail(new Error("Sparky could not send your spoken message."));
          } catch (error) {
            fail(error);
          }
        })();
      };

      try {
        current.start(250);
      } catch (error) {
        fail(error);
        return;
      }
      changePhase("listening");
      report("Listening…");
      const tick = () => {
        if (closed || current.state !== "recording" || !analyser) return;
        analyser.getFloatTimeDomainData(wave);
        const rms = microphoneRms(wave);
        const now = performance.now();
        if (rms > speechThreshold(noiseFloor)) {
          loudFrames++;
          if (loudFrames >= 2) {
            lastLoudAt = now;
            speechDetected = true;
            if (phaseRef.current === "listening") {
              changePhase("recording");
              report("Hearing you…");
            }
          }
        } else {
          loudFrames = 0;
          if (!speechDetected) noiseFloor = noiseFloor * 0.98 + rms * 0.02;
        }
        if (shouldFinishUtterance(now - startedAt, now - lastLoudAt, speechDetected)) {
          current.stop();
          return;
        }
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    };
    listenRef.current = listen;

    void (async () => {
      try {
        report("Requesting microphone access…");
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Microphone access is unavailable.");
        }
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
        // Initializing Workers can throw synchronously if Electron blocks their
        // script or worker origins. Handle that as a visible error, not a blank UI.
        speaker = new TinyVocaSpeaker(audioContext, report);
        speakerRef.current = speaker;
        transcriber = new LocalSpeechTranscriber(report);
        // The microphone can start immediately; model downloads occur in parallel.
        void Promise.all([speaker.load(), transcriber.load()]).catch(fail);
        if (!closed) listen();
      } catch (error) {
        fail(error);
      }
    })();

    return () => {
      closed = true;
      closedRef.current = true;
      cancelRecording();
      listenRef.current = null;
      cancelRecordingRef.current = null;
      speakerRef.current = null;
      speaker?.dispose();
      transcriber?.dispose();
      stream?.getTracks().forEach((track) => track.stop());
      if (inputContext) void inputContext.close();
      outputCloseTimer.current = setTimeout(() => {
        if (audioContext.state !== "closed") void audioContext.close();
        outputCloseTimer.current = null;
      }, 0);
    };
  }, [audioContext]);

  // Pending approvals remain in the ordinary chat, so listening pauses until
  // the user has finished interacting with them.
  useEffect(() => {
    if (needsAttention) {
      if (phase === "listening" || phase === "recording" || phase === "speaking") {
        cancelRecordingRef.current?.();
        speakerRef.current?.stop();
        changePhase("paused");
        onStatusRef.current("Review the request in chat…");
      }
    } else if (phase === "paused") {
      listenRef.current?.();
    }
  }, [needsAttention, phase]);

  useEffect(() => {
    if (phase !== "waiting" || busy || !settled || needsAttention) return;
    const answer = latestNewAssistant(messages, baselineAssistantIdRef.current);
    if (!answer) return;
    baselineAssistantIdRef.current = answer.id;
    const speechText = textForSpeech(answer.text);
    if (!speechText) {
      listenRef.current?.();
      return;
    }
    changePhase("speaking");
    onStatusRef.current("Speaking…");
    void speakerRef.current?.speak(speechText, voice, speed).then(
      () => {
        if (!closedRef.current && phaseRef.current === "speaking") listenRef.current?.();
      },
      (error: unknown) => {
        if (!closedRef.current) {
          onErrorRef.current(error instanceof Error ? error.message : "Voice playback failed.");
          onCloseRef.current();
        }
      },
    );
  }, [busy, messages, needsAttention, phase, settled, speed, voice]);

  return null;
}
