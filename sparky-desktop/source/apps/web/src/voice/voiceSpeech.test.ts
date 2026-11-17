import { describe, expect, it } from "vite-plus/test";
import { completedVoiceReply, latestAssistantId, textForSpeech } from "./voiceSpeech";

describe("voice speech text", () => {
  it("speaks prose but does not vocalize fenced code or URLs", () => {
    const result = textForSpeech("# Summary\nSee [the guide](https://example.com).\n\n" +
      "```ts\nconst password = 'secret';\n```\n- Done.");
    expect(result).toContain("Summary See the guide.");
    expect(result).toContain("Code example.");
    expect(result).not.toContain("password");
    expect(result).not.toContain("https://");
    expect(result).toContain("Done.");
  });

  it("waits for the next completed assistant reply and ignores prior messages", () => {
    const messages = [
      { id: "a", role: "assistant", text: "Previous" },
      { id: "u", role: "user", text: "New question" },
      { id: "b", role: "assistant", text: "Still talking", streaming: true },
    ];
    expect(latestAssistantId(messages)).toBe("b");
    expect(completedVoiceReply(messages, "a")).toBeNull();
    expect(completedVoiceReply([...messages, { id: "c", role: "assistant", text: "Final" }], "a")?.text).toBe("Final");
    expect(completedVoiceReply(messages, "missing")).toBeNull();
  });
});
