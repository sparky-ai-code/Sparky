import { describe, expect, it } from "vite-plus/test";
import {
  latestNewAssistant,
  microphoneRms,
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

  it("finishes only after silence or maximum recording duration", () => {
    expect(shouldFinishUtterance(500, 1200, false)).toBe(false);
    expect(shouldFinishUtterance(500, 1200, true)).toBe(true);
    expect(shouldFinishUtterance(30_000, 0, false)).toBe(true);
    expect(microphoneRms(new Float32Array([0.2, -0.2]))).toBeCloseTo(0.2);
  });
});
