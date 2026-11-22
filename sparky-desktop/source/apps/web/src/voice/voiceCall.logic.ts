/** Pure helpers for the voice call: turn detection, barge-in, and read-out segmentation. */

/** Silence after the user stops speaking before what they said is sent. */
export const UTTERANCE_SILENCE_MS = 2_000;
/** Longest single utterance before it is sent regardless of silence. */
export const MAX_UTTERANCE_MS = 30_000;
/** Loud speech must last this long to count as the user speaking over Sparky. */
export const BARGE_IN_MS = 350;
/** A short stretch of loud sound confirms the start of an utterance while Sparky is quiet. */
export const SPEECH_START_MS = 60;

export function textForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " Code example omitted. ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^[>|*+-]\s+/gm, "")
    .replace(/\*\*|__|[`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}

function fenceCount(text: string): number {
  return text.split("```").length - 1;
}

/**
 * The end of the last sentence or line in `text` that is complete (after `from`).
 * Returns `from` when there is none. A sentence ends with . ! ? or … followed by
 * whitespace, or at a line break; breaks inside an open code fence do not count.
 * While a reply streams, the unfinished last sentence is not returned.
 */
export function lastCompleteSpeechEnd(text: string, from: number): number {
  let end = from;
  for (let i = from; i < text.length; i++) {
    const char = text[i]!;
    let candidate = -1;
    if (char === "\n") {
      candidate = i + 1;
    } else if (".!?…".includes(char) && i + 1 < text.length && /\s/.test(text[i + 1]!)) {
      candidate = i + 1;
    }
    if (candidate < 0) continue;
    if (fenceCount(text.slice(0, candidate)) % 2 === 1) continue;
    end = candidate;
  }
  return end;
}

/**
 * Tracks which assistant text has already been read aloud. Messages that existed
 * before the user spoke are ignored; a streaming reply is read sentence by sentence.
 */
export class ReadAloudTracker {
  private readonly ignored = new Set<string>();
  private readonly offsets = new Map<string, number>();

  /** Ignore the replies that exist now (the user is about to speak). Streaming replies stay eligible. */
  ignoreExisting(messages: ReadonlyArray<SpokenMessage>): void {
    for (const message of messages) {
      if (message.role === "assistant" && !message.streaming) this.ignored.add(String(message.id));
    }
  }

  /** Mark what is currently written as already read, so barge-in skips to the next sentence. */
  skipCurrent(messages: ReadonlyArray<SpokenMessage>): void {
    for (const message of messages) {
      if (message.role !== "assistant" || this.ignored.has(String(message.id))) continue;
      this.offsets.set(String(message.id), message.text.length);
    }
  }

  /** Text that should be spoken now, in order. */
  advance(messages: ReadonlyArray<SpokenMessage>): string[] {
    const segments: string[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const id = String(message.id);
      if (this.ignored.has(id)) continue;
      const offset = this.offsets.get(id) ?? 0;
      const end = message.streaming ? lastCompleteSpeechEnd(message.text, offset) : message.text.length;
      if (end > offset) {
        this.offsets.set(id, end);
        // A skipped sentence can leave its closing punctuation at the start of the next piece.
        const spoken = textForSpeech(message.text.slice(offset, end).replace(/^[\s.,;:!?…]+/, ""));
        if (spoken) segments.push(spoken);
      }
      // An empty placeholder is not a finished reply yet; keep watching it.
      if (!message.streaming && message.text.length > 0) this.ignored.add(id);
    }
    return segments;
  }
}

export interface SpokenMessage {
  readonly id: string | number;
  readonly role: string;
  readonly text: string;
  readonly streaming?: boolean;
}

export function shouldShowInlineVoiceAction(input: {
  isRunning: boolean;
  pendingAction: boolean;
  showPlanFollowUpPrompt: boolean;
  hasSendableContent: boolean;
}): boolean {
  return !input.isRunning && !input.pendingAction && !input.showPlanFollowUpPrompt && !input.hasSendableContent;
}

/**
 * Speech must be clearly louder than the room's own noise. The threshold follows the
 * measured noise floor with no low cap: a fixed ceiling let steady noise such as a
 * laptop fan count as speech, so the call never went quiet and nothing was transcribed.
 * The floor sits at 0.0035 so a silent room still needs real sound to start a turn.
 */
export function speechThreshold(noiseFloorRms: number): number {
  return Math.max(0.0035, Math.min(0.3, noiseFloorRms * 2.8));
}

/**
 * While Sparky is talking, its own voice can leak into the microphone. Interrupting
 * needs clearly louder sound than normal speech detection.
 */
export function bargeInThreshold(noiseFloorRms: number): number {
  return Math.max(0.03, speechThreshold(noiseFloorRms) * 1.5);
}

export async function transcribeAndSend(
  samples: Float32Array,
  transcribe: (samples: Float32Array) => Promise<string>,
  send: (transcript: string) => Promise<boolean>,
  onTranscript?: (transcript: string) => void,
): Promise<{ transcript: string; sent: boolean }> {
  const transcript = (await transcribe(samples)).trim();
  if (!transcript) return { transcript: "", sent: false };
  onTranscript?.(transcript);
  return { transcript, sent: await send(transcript) };
}

export function microphoneRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  return Math.sqrt(squares / samples.length);
}

/** Whether the current utterance is complete: speech has ended after enough silence. */
export function shouldFinishUtterance(
  durationMs: number,
  silenceMs: number,
  speechDetected: boolean,
): boolean {
  return (speechDetected && durationMs >= 450 && silenceMs >= UTTERANCE_SILENCE_MS) || durationMs >= MAX_UTTERANCE_MS;
}
