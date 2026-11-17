// Browser-only test harness. Not part of the production app or its build.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VoiceSession } from "./VoiceSession";

type Message = { id: string; role: "user" | "assistant"; text: string; streaming: boolean };
declare global {
  interface Window {
    __voiceStatusHistory?: string[];
    __voiceTestError?: string;
  }
}

function Smoke() {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(true);
  const outputContext = useRef<AudioContext | null>(null);
  const sentCount = useRef(0);

  const start = () => {
    outputContext.current = new AudioContext();
    void outputContext.current.resume();
    setActive(true);
  };
  const send = async (transcript: string) => {
    if (!transcript.trim()) throw new Error("Empty transcript passed to onSend");
    sentCount.current++;
    setMessages((existing) => [...existing, {
      id: "user-" + sentCount.current,
      role: "user",
      text: transcript,
      streaming: false,
    }]);
    setBusy(true);
    setSettled(false);
    window.setTimeout(() => {
      setMessages((existing) => [...existing, {
        id: "assistant-" + sentCount.current,
        role: "assistant",
        text: "Hello there. Sparky is speaking.",
        streaming: false,
      }]);
      setBusy(false);
      setSettled(true);
    }, 60);
    return true;
  };

  return (
    <main>
      <button type="button" onClick={start} disabled={active}>Start voice test</button>
      <div data-testid="voice-status">{status}</div>
      <div data-testid="voice-error">{error}</div>
      <div data-testid="chat-feed">
        {messages.map((message) => (
          <p key={message.id} data-role={message.role}>{message.text}</p>
        ))}
      </div>
      {active && outputContext.current ? (
        <VoiceSession
          audioContext={outputContext.current}
          messages={messages}
          busy={busy}
          settled={settled}
          needsAttention={false}
          voice="F2"
          speed={1}
          onSend={send}
          onStatus={(message) => {
            window.__voiceStatusHistory ??= [];
            window.__voiceStatusHistory.push(message);
            setStatus(message);
          }}
          onError={(message) => {
            window.__voiceTestError = message;
            setError(message);
          }}
          onClose={() => setActive(false)}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Smoke />);
