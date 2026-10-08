import { describe, expect, it } from "vite-plus/test";
import { parseHarnessMentions, serializeHarnessToken } from "./harnessMentions.ts";

describe("ACP harness mentions", () => {
  it("serializes and removes a selected harness while preserving the prompt", () => {
    const token = serializeHarnessToken("claudeHarness");
    expect(token).toBe("@agent:claudeHarness");
    expect(parseHarnessMentions(`Please fix this ${token} carefully`)).toEqual({
      instanceId: "claudeHarness",
      prompt: "Please fix this  carefully",
      error: null,
    });
  });

  it("does not route code examples or ordinary @mentions", () => {
    expect(parseHarnessMentions("Email @codex and show `@agent:claudeHarness`")).toEqual({
      instanceId: null,
      prompt: "Email @codex and show `@agent:claudeHarness`",
      error: null,
    });
  });

  it("rejects messages that tag multiple harnesses", () => {
    const parsed = parseHarnessMentions("@agent:codexHarness and @agent:claudeHarness help");
    expect(parsed.error).toContain("one harness");
  });
});
