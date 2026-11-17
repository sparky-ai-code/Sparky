import { useEffect, useRef, useState } from "react";
import { AudioLinesIcon, MicIcon, MicOffIcon, PhoneOffIcon, SquareIcon } from "lucide-react";
import { TinyVocaSpeaker, type TinyVocaChoice } from "./tinyVocaSpeaker";
import {
  completedVoiceReply,
  latestAssistantId,
  textForSpeech,
  type VoiceMessage,
} from "./voiceSpeech";

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface RecognitionError {
  error: string;
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionError) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;

interface VoiceCallProps {
  messages: ReadonlyArray<VoiceMessage>;
  voiceChoice: TinyVocaChoice;
  voiceSpeed: number;
  isBusy: boolean;
  latestTurnSettled: boolean;
  canSend: boolean;
  onTranscript: (text: string) => void;
  onInterrupt: () => void;
  onClose: () => void;
}

interface PendingVoiceTurn {
  readonly assistantBefore: string | null;
  hadBusy: boolean;
}

export function VoiceCall({
  messages,
  voiceChoice,
  voiceSpeed,
  isBusy,
  latestTurnSettled,
  canSend,
  onTranscript,
  onInterrupt,
  onClose,
}: VoiceCallProps) {
  const [status, setStatus] = useState("Starting voice call…");
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const recognitionRef = useRef<Recognition | null>(null);
  const speakerRef = useRef<TinyVocaSpeaker | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<PendingVoiceTurn | null>(null);
  const closedRef = useRef(false);
  const mutedRef = useRef(false);
  const listeningRef = useRef(false);
  const speakingRef = useRef(false);
  const messagesRef = useRef(messages);
  const canSendRef = useRef(canSend);
  const busyRef = useRef(isBusy);
  const onTranscriptRef = useRef(onTranscript);
  messagesRef.current = messages;
  canSendRef.current = canSend;
  busyRef.current = isBusy;
  onTranscriptRef.current = onTranscript;

  function listen() {
    if (
      closedRef.current ||
      mutedRef.current ||
      speakingRef.current ||
      pendingRef.current ||
      listeningRef.current ||
      busyRef.current ||
      !canSendRef.current
    ) return;
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.start();
      listeningRef.current = true;
      setListening(true);
      setStatus("Listening…");
    } catch {
      setStatus("Could not start the microphone. Check its permissions.");
    }
  }

  function stopListening() {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (!listeningRef.current) return;
    listeningRef.current = false;
    setListening(false);
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
  }

  useEffect(() => {
    closedRef.current = false;
    const speaker = new TinyVocaSpeaker((message) => {
      if (!closedRef.current && !pendingRef.current && !speakingRef.current) setStatus(message);
    });
    speakerRef.current = speaker;
    void speaker.load().catch((error: unknown) => {
      if (!closedRef.current) {
        setStatus(error instanceof Error ? error.message : "Could not load Tiny Voca");
      }
    });
    const recognitionHost = window as typeof window & {
      SpeechRecognition?: RecognitionConstructor;
      webkitSpeechRecognition?: RecognitionConstructor;
    };
    const RecognitionApi =
      recognitionHost.SpeechRecognition ?? recognitionHost.webkitSpeechRecognition;
    if (!RecognitionApi) {
      setStatus("Voice input is not supported by this browser. Try Chromium with speech recognition.");
      return () => {
        closedRef.current = true;
        speaker.close();
        speakerRef.current = null;
      };
    }
    const recognition = new RecognitionApi();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      if (closedRef.current || pendingRef.current || speakingRef.current) return;
      let transcript = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result?.isFinal) transcript += " " + (result[0]?.transcript ?? "");
      }
      transcript = transcript.trim();
      if (!transcript || !canSendRef.current || busyRef.current) return;
      pendingRef.current = {
        assistantBefore: latestAssistantId(messagesRef.current),
        hadBusy: false,
      };
      stopListening();
      setStatus("Sparky is thinking…");
      onTranscriptRef.current(transcript);
    };
    recognition.onerror = (event) => {
      if (closedRef.current || event.error === "aborted") return;
      if (event.error === "no-speech") {
        setStatus("Listening…");
        return;
      }
      mutedRef.current = true;
      setMuted(true);
      setStatus("Microphone error: " + event.error + ". Check microphone access, then unmute.");
    };
    recognition.onend = () => {
      listeningRef.current = false;
      if (!closedRef.current) setListening(false);
      if (
        !closedRef.current &&
        !mutedRef.current &&
        !pendingRef.current &&
        !speakingRef.current
      ) {
        restartTimerRef.current = window.setTimeout(listen, 500);
      }
    };
    listen();
    return () => {
      closedRef.current = true;
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try { recognition.abort(); } catch { /* unsupported */ }
      recognitionRef.current = null;
      speaker.close();
      speakerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) {
      if (!isBusy && canSend && !speakingRef.current && !mutedRef.current) listen();
      return;
    }
    if (isBusy || !latestTurnSettled) {
      pending.hadBusy = true;
      return;
    }
    const answer = completedVoiceReply(messages, pending.assistantBefore);
    if (!answer && !pending.hadBusy) return;
    pendingRef.current = null;
    if (!answer) {
      setStatus("Sparky finished without a spoken reply.");
      if (!mutedRef.current) listen();
      return;
    }
    const spokenText = textForSpeech(answer.text);
    if (!spokenText) {
      setStatus("Ready for the next question.");
      if (!mutedRef.current) listen();
      return;
    }
    speakingRef.current = true;
    stopListening();
    setSpeaking(true);
    setStatus("Speaking…");
    void speakerRef.current?.speak(spokenText, voiceChoice, voiceSpeed)
      .catch((error: unknown) => {
        if (!closedRef.current) {
          setStatus(error instanceof Error ? error.message : "Speech playback failed");
        }
      })
      .finally(() => {
        if (closedRef.current) return;
        speakingRef.current = false;
        setSpeaking(false);
        if (!mutedRef.current) listen();
      });
  }, [messages, isBusy, latestTurnSettled, canSend, voiceChoice, voiceSpeed]);

  function toggleMute() {
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    setMuted(nextMuted);
    if (nextMuted) {
      stopListening();
      setStatus("Microphone muted");
    } else {
      setStatus("Microphone unmuted");
      listen();
    }
  }

  function stopCurrent() {
    if (speakingRef.current) {
      speakerRef.current?.stop();
      speakingRef.current = false;
      setSpeaking(false);
      if (!mutedRef.current) listen();
    }
    if (isBusy) {
      pendingRef.current = null;
      onInterrupt();
      setStatus("Stopping Sparky…");
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Voice call"
        className="flex w-full max-w-sm flex-col items-center gap-6 rounded-3xl border border-border bg-card px-7 py-8 text-center text-card-foreground shadow-2xl"
      >
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Sparky Voice</h2>
          <p className="text-xs text-muted-foreground">Using your current model and thread · English</p>
        </div>
        <div className="flex h-24 w-24 items-center justify-center rounded-full border border-primary/25 bg-primary/10">
          <AudioLinesIcon className="h-12 w-12 text-primary" aria-hidden="true" />
        </div>
        <p role="status" aria-live="polite" className="min-h-10 text-sm text-muted-foreground">
          {status}
        </p>
        <div className="flex items-center justify-center gap-4">
          <button
            type="button"
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            title={muted ? "Unmute microphone" : "Mute microphone"}
            onClick={toggleMute}
            className="flex size-12 items-center justify-center rounded-full border border-border bg-muted hover:bg-accent"
          >
            {muted ? <MicOffIcon className="size-5" /> : <MicIcon className="size-5" />}
          </button>
          <button
            type="button"
            aria-label="End voice call"
            title="End voice call"
            onClick={onClose}
            className="flex size-14 items-center justify-center rounded-full bg-destructive text-white hover:opacity-90"
          >
            <PhoneOffIcon className="size-6" />
          </button>
          <button
            type="button"
            aria-label="Stop speaking or stop response"
            title="Stop speaking or stop response"
            disabled={!speaking && !isBusy}
            onClick={stopCurrent}
            className="flex size-12 items-center justify-center rounded-full border border-border bg-muted hover:bg-accent disabled:opacity-40"
          >
            <SquareIcon className="size-5" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {speaking ? "Audio is playing" : listening ? "Microphone active" : muted ? "Microphone off" : "Waiting"}
          {" · "}{voiceChoice} at {voiceSpeed.toFixed(2)}×
        </p>
      </section>
    </div>
  );
}
