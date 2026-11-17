import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AudioLinesIcon, MicIcon, MicOffIcon, Minimize2Icon, PhoneOffIcon, XIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { decodeRecordedSpeech, LocalSpeechTranscriber, TinyVocaSpeaker } from "./voiceEngines";
import {
  latestNewAssistant,
  microphoneRms,
  shouldFinishUtterance,
  textForSpeech,
} from "./voiceCall.logic";

type Phase = "loading" | "listening" | "recording" | "transcribing" | "waiting" | "speaking" | "error";

export interface VoiceCallProps {
  audioContext: AudioContext;
  messages: ReadonlyArray<{ id: string; role: string; text: string; streaming?: boolean }>;
  busy: boolean;
  settled: boolean;
  needsAttention: boolean;
  voice: "F2" | "M2";
  speed: number;
  onSend: (transcript: string) => Promise<boolean>;
  onInterrupt: () => void;
  onClose: () => void;
}

/** A call is only another way to interact with an existing Sparky thread. */
export function VoiceCall({
  audioContext,
  messages,
  busy,
  settled,
  needsAttention,
  voice,
  speed,
  onSend,
  onInterrupt,
  onClose,
}: VoiceCallProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [detail, setDetail] = useState("Preparing local voice models…");
  const [caption, setCaption] = useState("");
  const [muted, setMuted] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [level, setLevel] = useState(0);
  const phaseRef = useRef<Phase>("loading");
  const mutedRef = useRef(false);
  const closedRef = useRef(false);
  const speakerRef = useRef<TinyVocaSpeaker | null>(null);
  const resumeRef = useRef<(() => void) | null>(null);
  const cancelRecordingRef = useRef<(() => void) | null>(null);
  const baselineAssistantIdRef = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  const onSendRef = useRef(onSend);
  messagesRef.current = messages;
  onSendRef.current = onSend;

  const changePhase = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  useEffect(() => {
    closedRef.current = false;
    let closed = false;
    let stream: MediaStream | null = null;
    let inputContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let frame = 0;
    let recorder: MediaRecorder | null = null;
    let cancelledRecording = false;
    const speaker = new TinyVocaSpeaker(audioContext, (message) => {
      if (!closed) setDetail(message);
    });
    const transcriber = new LocalSpeechTranscriber((message) => {
      if (!closed) setDetail(message);
    });
    speakerRef.current = speaker;

    const cancelRecording = () => {
      cancelledRecording = true;
      window.cancelAnimationFrame(frame);
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      recorder = null;
    };
    cancelRecordingRef.current = cancelRecording;

    const listen = () => {
      if (closed || !stream || !analyser) return;
      if (mutedRef.current) {
        changePhase("listening");
        setDetail("Microphone muted");
        return;
      }
      if (recorder?.state === "recording") return;
      if (typeof MediaRecorder === "undefined") {
        changePhase("error");
        setDetail("Audio recording is unavailable in this environment.");
        return;
      }
      cancelledRecording = false;
      const current = new MediaRecorder(stream);
      recorder = current;
      const chunks: BlobPart[] = [];
      const startAt = performance.now();
      let speechDetected = false;
      let lastLoudAt = startAt;
      const wave = new Float32Array(analyser.fftSize);

      current.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      current.onstop = () => {
        window.cancelAnimationFrame(frame);
        if (closed || cancelledRecording) return;
        recorder = null;
        if (!speechDetected || chunks.length === 0) {
          listen();
          return;
        }
        changePhase("transcribing");
        setDetail("Understanding you…");
        void (async () => {
          try {
            const pcm = await decodeRecordedSpeech(new Blob(chunks, { type: current.mimeType }));
            if (closed) return;
            const transcript = (await transcriber.transcribe(pcm)).trim();
            if (closed) return;
            if (!transcript) {
              listen();
              return;
            }
            setCaption("You: " + transcript);
            baselineAssistantIdRef.current =
              String([...messagesRef.current].reverse().find((message) => message.role === "assistant")?.id ?? "") || null;
            changePhase("waiting");
            setDetail("Sparky is working…");
            const sent = await onSendRef.current(transcript);
            if (!closed && !sent) {
              setDetail("Sparky couldn't send that message. You can try again.");
              listen();
            }
          } catch (error) {
            if (!closed) {
              changePhase("error");
              setDetail(error instanceof Error ? error.message : "Speech recognition failed.");
            }
          }
        })();
      };

      current.start(250);
      changePhase("listening");
      setDetail("Listening");
      const tick = () => {
        if (closed || current.state !== "recording" || mutedRef.current || !analyser) return;
        analyser.getFloatTimeDomainData(wave);
        const rms = microphoneRms(wave);
        setLevel(Math.min(1, rms * 14));
        const now = performance.now();
        if (rms > 0.024) {
          lastLoudAt = now;
          speechDetected = true;
          if (phaseRef.current === "listening") changePhase("recording");
        }
        if (shouldFinishUtterance(now - startAt, now - lastLoudAt, speechDetected)) {
          current.stop();
          return;
        }
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    };
    resumeRef.current = listen;

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Microphone access is unavailable in this environment.");
        }
        // The microphone stays inside the call. It is never passed to Sparky's model provider.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (closed) return;
        inputContext = new AudioContext();
        const source = inputContext.createMediaStreamSource(stream);
        analyser = inputContext.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        await Promise.all([speaker.load(), transcriber.load()]);
        if (!closed) listen();
      } catch (error) {
        if (!closed) {
          changePhase("error");
          setDetail(error instanceof Error ? error.message : "Could not start the voice call.");
        }
      }
    })();

    return () => {
      closed = true;
      closedRef.current = true;
      cancelRecording();
      resumeRef.current = null;
      cancelRecordingRef.current = null;
      speaker.dispose();
      transcriber.dispose();
      stream?.getTracks().forEach((track) => track.stop());
      if (inputContext) void inputContext.close();
      void audioContext.close();
    };
  }, [audioContext]);

  useEffect(() => {
    if (phase !== "waiting" || busy || !settled) return;
    const answer = latestNewAssistant(messages, baselineAssistantIdRef.current);
    if (!answer) return;
    baselineAssistantIdRef.current = answer.id;
    const text = textForSpeech(answer.text);
    if (!text) {
      resumeRef.current?.();
      return;
    }
    changePhase("speaking");
    setCaption("Sparky: " + text);
    setDetail("Sparky is speaking");
    void speakerRef.current?.speak(text, voice, speed).then(
      () => {
        if (!closedRef.current && phaseRef.current === "speaking") {
          if (mutedRef.current) {
            changePhase("listening");
            setDetail("Microphone muted");
          } else {
            resumeRef.current?.();
          }
        }
      },
      (error: unknown) => {
        if (!closedRef.current) {
          changePhase("error");
          setDetail(error instanceof Error ? error.message : "Speech playback failed.");
        }
      },
    );
  }, [busy, messages, phase, settled, speed, voice]);

  useEffect(() => {
    if (needsAttention) {
      setMinimized(true);
      setDetail("Sparky needs your input in the chat.");
    }
  }, [needsAttention]);

  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) {
      cancelRecordingRef.current?.();
      if (phaseRef.current === "listening" || phaseRef.current === "recording") {
        setDetail("Microphone muted");
      }
    } else if (phaseRef.current === "listening" || phaseRef.current === "recording") {
      resumeRef.current?.();
    }
  };
  const interrupt = () => {
    speakerRef.current?.stop();
    if (phaseRef.current === "waiting") onInterrupt();
    if (mutedRef.current) {
      changePhase("listening");
      setDetail("Microphone muted");
    } else {
      resumeRef.current?.();
    }
  };
  const status =
    phase === "loading" ? "Connecting"
      : phase === "listening" ? "Listening"
        : phase === "recording" ? "Hearing you"
          : phase === "transcribing" ? "Transcribing"
            : phase === "waiting" ? "Sparky is working"
              : phase === "speaking" ? "Speaking"
                : "Voice unavailable";

  const content = minimized ? (
    <div className="fixed bottom-5 right-5 z-[160] flex items-center gap-3 rounded-full border bg-background px-4 py-3 shadow-xl" role="region" aria-label="Voice call">
      <AudioLinesIcon className="size-5 text-primary" />
      <span className="text-sm">{status}</span>
      <button type="button" onClick={() => setMinimized(false)} aria-label="Expand voice call" className="rounded-full border px-3 py-1.5 text-xs">Expand</button>
      <button type="button" onClick={onClose} aria-label="End voice call" className="rounded-full bg-destructive p-2 text-white"><PhoneOffIcon className="size-4" /></button>
    </div>
  ) : (
    <div className="fixed inset-0 z-[160] flex items-center justify-center bg-background/95 p-4 backdrop-blur-xl" role="dialog" aria-modal="true" aria-label="Sparky voice call">
      <div className="absolute right-5 top-5 flex gap-2">
        <button type="button" aria-label="Minimize voice call" onClick={() => setMinimized(true)} className="rounded-full p-3 text-muted-foreground hover:bg-muted"><Minimize2Icon className="size-5" /></button>
        <button type="button" aria-label="End voice call" onClick={onClose} className="rounded-full p-3 text-muted-foreground hover:bg-muted"><XIcon className="size-5" /></button>
      </div>
      <div className="flex w-full max-w-xl flex-col items-center gap-8 text-center">
        <p className="text-sm font-medium tracking-wide text-muted-foreground">Sparky Voice</p>
        <div className={cn(
          "flex size-44 items-center justify-center rounded-full border border-primary/20 bg-primary/10 transition-all duration-200",
          phase === "speaking" && "animate-pulse",
        )}>
          <AudioLinesIcon className="size-16 text-primary" style={{ transform: `scale(${1 + level * 0.16})` }} aria-hidden="true" />
        </div>
        <div className="min-h-24 space-y-3">
          <h2 className="text-2xl font-semibold">{status}</h2>
          <p role="status" className="text-sm text-muted-foreground">{detail}</p>
          {caption ? <p className="mx-auto max-h-28 max-w-lg overflow-y-auto text-sm leading-relaxed">{caption}</p> : null}
        </div>
        <div className="flex items-center gap-4">
          <button type="button" aria-label={muted ? "Unmute microphone" : "Mute microphone"} onClick={toggleMute} className="flex size-14 items-center justify-center rounded-full border bg-muted/60 transition-colors hover:bg-muted" disabled={phase === "error"}>
            {muted ? <MicOffIcon className="size-6" /> : <MicIcon className="size-6" />}
          </button>
          <button type="button" aria-label="Interrupt and listen" onClick={interrupt} disabled={phase === "loading" || phase === "error" || phase === "transcribing"} className="rounded-full border px-5 py-3 text-sm font-medium disabled:opacity-40">
            Interrupt
          </button>
          <button type="button" aria-label="End voice call" onClick={onClose} className="flex size-14 items-center justify-center rounded-full bg-destructive text-white hover:bg-destructive/90">
            <PhoneOffIcon className="size-6" />
          </button>
        </div>
        <p className="max-w-sm text-xs text-muted-foreground">
          Spoken requests use the same thread, model, tools and permissions as text chat.
          Voice and speech recognition run locally after their initial download.
        </p>
      </div>
    </div>
  );

  return typeof document === "undefined" ? null : createPortal(content, document.body);
}
