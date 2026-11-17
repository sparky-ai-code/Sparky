import { useEffect, useRef, useState } from "react";
import { AudioLinesIcon, MicIcon, MicOffIcon, PhoneOffIcon, SquareIcon } from "lucide-react";
import { LocalMicrophone } from "./localMicrophone";
import { TinyVocaSpeaker, type TinyVocaChoice } from "./tinyVocaSpeaker";
import {
  completedVoiceReply,
  latestAssistantId,
  textForSpeech,
  type VoiceMessage,
} from "./voiceSpeech";

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
  const [status, setStatus] = useState("Preparing local voice call…");
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const microphoneRef = useRef<LocalMicrophone | null>(null);
  const speakerRef = useRef<TinyVocaSpeaker | null>(null);
  const pendingRef = useRef<PendingVoiceTurn | null>(null);
  const closedRef = useRef(false);
  const mutedRef = useRef(false);
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
      busyRef.current ||
      !canSendRef.current
    ) return;
    void microphoneRef.current?.start();
  }

  useEffect(() => {
    closedRef.current = false;
    const speaker = new TinyVocaSpeaker((message) => {
      if (!closedRef.current && speakingRef.current) setStatus(message);
    });
    const microphone = new LocalMicrophone(
      (transcript) => {
        if (closedRef.current || pendingRef.current || speakingRef.current) return;
        if (busyRef.current || !canSendRef.current) return;
        pendingRef.current = {
          assistantBefore: latestAssistantId(messagesRef.current),
          hadBusy: false,
        };
        microphone.stop();
        setStatus("Sparky is thinking…");
        onTranscriptRef.current(transcript);
      },
      (message) => {
        if (!closedRef.current) setStatus(message);
      },
      (active) => {
        if (!closedRef.current) setListening(active);
      },
    );
    speakerRef.current = speaker;
    microphoneRef.current = microphone;
    // The TTS worker can warm up while speech input downloads its first-use model.
    void speaker.load().catch(() => {});
    if (!mutedRef.current) void microphone.start();
    return () => {
      closedRef.current = true;
      microphone.close();
      speaker.close();
      microphoneRef.current = null;
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
    microphoneRef.current?.stop();
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
      microphoneRef.current?.stop();
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
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-end justify-end p-4 sm:p-6">
      <section
        role="dialog"
        aria-modal="false"
        aria-label="Voice call"
        className="pointer-events-auto flex w-full max-w-sm flex-col items-center gap-6 rounded-3xl border border-border bg-card px-7 py-8 text-center text-card-foreground shadow-2xl"
      >
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Sparky Voice</h2>
          <p className="text-xs text-muted-foreground">Your current model and thread · English</p>
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
        {!listening && !muted && !speaking && !isBusy && canSend ? (
          <button
            type="button"
            onClick={listen}
            className="text-xs font-medium text-primary hover:underline"
          >
            Retry microphone
          </button>
        ) : null}
      </section>
    </div>
  );
}
