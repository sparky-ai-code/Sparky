import { describe, expect, it } from "vite-plus/test";
import {
  latestNewAssistant,
  microphoneRms,
  speechThreshold,
  transcribeAndSend,
  shouldShowInlineVoiceAction,
  shouldFinishUtterance,
  textForSpeech,
} from "./voiceCall.logic";

describe("voice-call lifecycle helpers", () => {
  it("does not replay an existing assistant response", () => {
    const messages = [{ id: "old", role: "assistant", text: "Earlier answer", streaming: false }];
    expect(latestNewAssistant(messages, "old")).toBeNull();
    expect(latestNewAssistant([...messages, { id: "new", role: "assistant", text: "Latest answer", streaming: false }], "old")).toEqual({ id: "new", text: "Latest answer" });
  });

  it("does not speak an unfinished assistant stream", () => {
    expect(latestNewAssistant([{ id: "new", role: "assistant", text: "Partial", streaming: true }], null)).toBeNull();
  });

  it("speaks prose without leaking raw code and URLs", () => {
    const output = textForSpeech("# Result\n**Done** [here](https://example.com)\n```ts\nsecretCall()\n```");
    expect(output).toContain("Done here");
    expect(output).not.toContain("secretCall");
    expect(output).not.toContain("example.com");
  });

  it("only replaces an empty send action, preserving text, attachments, stop and approval controls", () => {
    const empty = { isRunning: false, pendingAction: false, showPlanFollowUpPrompt: false, hasSendableContent: false };
    expect(shouldShowInlineVoiceAction(empty)).toBe(true);
    expect(shouldShowInlineVoiceAction({ ...empty, hasSendableContent: true })).toBe(false);
    expect(shouldShowInlineVoiceAction({ ...empty, isRunning: true })).toBe(false);
    expect(shouldShowInlineVoiceAction({ ...empty, pendingAction: true })).toBe(false);
    expect(shouldShowInlineVoiceAction({ ...empty, showPlanFollowUpPrompt: true })).toBe(false);
  });

  it("detects normal, quiet microphone speech that the old 0.024 threshold ignored", () => {
    expect(speechThreshold(0.001)).toBe(0.0035);
    expect(0.008).toBeGreaterThan(speechThreshold(0.001));
    expect(speechThreshold(0.025)).toBeGreaterThan(0.025);
  });

  it("transcribes, automatically sends the recognized text, and surfaces the transcript", async () => {
    const calls: string[] = [];
    const send = async (text: string) => { calls.push("sent:" + text); return true; };
    const result = await transcribeAndSend(new Float32Array([0.01]), async () => "  hello Sparky  ", send, (text) => calls.push("heard:" + text));
    expect(result).toEqual({ transcript: "hello Sparky", sent: true });
    expect(calls).toEqual(["heard:hello Sparky", "sent:hello Sparky"]);
  });

  it("does not send silence or empty transcripts", async () => {
    let sends = 0;
    const result = await transcribeAndSend(new Float32Array(1), async () => "   ", async () => { sends++; return true; });
    expect(result).toEqual({ transcript: "", sent: false });
    expect(sends).toBe(0);
  });

  it("finishes only after silence or maximum recording duration", () => {
    expect(shouldFinishUtterance(500, 1200, false)).toBe(false);
    expect(shouldFinishUtterance(500, 1200, true)).toBe(true);
    expect(shouldFinishUtterance(30_000, 0, false)).toBe(true);
    expect(microphoneRms(new Float32Array([0.2, -0.2]))).toBeCloseTo(0.2);
  });
});
