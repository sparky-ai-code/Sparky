import { describe, expect, it } from "vite-plus/test";
import {
  bargeInThreshold,
  lastCompleteSpeechEnd,
  microphoneRms,
  ReadAloudTracker,
  shouldFinishUtterance,
  speechThreshold,
  textForSpeech,
  type SpokenMessage,
} from "./voiceCall.logic";

describe("voice turn detection", () => {
  it("sends the utterance after two seconds of silence, not earlier", () => {
    expect(shouldFinishUtterance(3_000, 1_999, true)).toBe(false);
    expect(shouldFinishUtterance(3_000, 2_000, true)).toBe(true);
  });

  it("waits for speech before ending a turn, and caps very long utterances", () => {
    expect(shouldFinishUtterance(10_000, 10_000, false)).toBe(false);
    expect(shouldFinishUtterance(30_000, 0, false)).toBe(true);
  });

  it("needs louder sound to interrupt Sparky than to start a turn", () => {
    expect(bargeInThreshold(0.001)).toBeGreaterThan(speechThreshold(0.001));
    expect(bargeInThreshold(0.001)).toBeGreaterThanOrEqual(0.03);
  });

  it("measures microphone level as RMS", () => {
    expect(microphoneRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(microphoneRms(new Float32Array(0))).toBe(0);
  });
});

describe("read-out segmentation", () => {
  it("ends a sentence at punctuation followed by whitespace", () => {
    const text = "It is sunny. Then";
    expect(text.slice(0, lastCompleteSpeechEnd(text, 0))).toBe("It is sunny.");
  });

  it("does not split an unfinished sentence while the reply streams", () => {
    expect(lastCompleteSpeechEnd("Partly writ", 0)).toBe(0);
    expect(lastCompleteSpeechEnd("3.14 is", 0)).toBe(0);
  });

  it("speaks line breaks as boundaries but never inside a code fence", () => {
    const text = "Run this:\n```\nlet a = 1. let b = 2;\n```\nThen stop";
    const end = lastCompleteSpeechEnd(text, 0);
    expect(text.slice(0, end)).toBe("Run this:\n```\nlet a = 1. let b = 2;\n```\n");
  });

  it("strips markdown before speaking", () => {
    expect(textForSpeech("**Bold** [link](https://x.test) and `code`.")).toBe("Bold link and code.");
  });
});

describe("ReadAloudTracker", () => {
  const message = (id: string, text: string, streaming = true): SpokenMessage => ({
    id,
    role: "assistant",
    text,
    streaming,
  });

  it("reads a streaming reply sentence by sentence and never repeats a sentence", () => {
    const tracker = new ReadAloudTracker();
    expect(tracker.advance([message("a", "First sentence.")])).toEqual([]);
    expect(tracker.advance([message("a", "First sentence. ")])).toEqual(["First sentence."]);
    expect(tracker.advance([message("a", "First sentence. Second")])).toEqual([]);
    expect(tracker.advance([message("a", "First sentence. Second one. Third")])).toEqual(["Second one."]);
    expect(tracker.advance([message("a", "First sentence. Second one. Third ends.", false)])).toEqual(["Third ends."]);
  });

  it("ignores replies that existed before the user spoke", () => {
    const tracker = new ReadAloudTracker();
    const before = [message("old", "Old answer.", false)];
    tracker.ignoreExisting(before);
    expect(tracker.advance([...before, message("new", "New answer.", false)])).toEqual(["New answer."]);
  });

  it("skips what was already written when the user interrupts", () => {
    const tracker = new ReadAloudTracker();
    const streaming = [message("a", "One thing. Another thing is long")];
    tracker.skipCurrent(streaming);
    expect(tracker.advance([message("a", "One thing. Another thing is long. Done now.", false)])).toEqual([
      "Done now.",
    ]);
  });

  it("does not treat an empty placeholder as a finished reply", () => {
    const tracker = new ReadAloudTracker();
    expect(tracker.advance([message("a", "", false)])).toEqual([]);
    expect(tracker.advance([message("a", "Late text.", false)])).toEqual(["Late text."]);
  });
});
