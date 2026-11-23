import { describe, expect, it } from "vite-plus/test";

import { getCompletedPromptRound, type PromptSuggestionThreadLike } from "./promptSuggestionRound";

function makeThread(
  overrides: Partial<PromptSuggestionThreadLike> = {},
): PromptSuggestionThreadLike {
  return {
    id: "thread-1",
    latestTurn: { turnId: "turn-2", state: "completed", assistantMessageId: "asst-2" },
    messages: [
      { id: "user-1", role: "user", text: "old question", turnId: "turn-1", streaming: false },
      { id: "asst-1", role: "assistant", text: "old answer", turnId: "turn-1", streaming: false },
      { id: "user-2", role: "user", text: "  add a retry  ", turnId: "turn-2", streaming: false },
      {
        id: "asst-2",
        role: "assistant",
        text: "Added a retry.",
        turnId: "turn-2",
        streaming: false,
      },
    ],
    ...overrides,
  };
}

describe("getCompletedPromptRound", () => {
  it("returns the latest completed round keyed by thread and turn", () => {
    expect(getCompletedPromptRound(makeThread())).toEqual({
      key: "thread-1:turn-2",
      threadId: "thread-1",
      turnId: "turn-2",
      userMessage: "add a retry",
      assistantMessage: "Added a retry.",
    });
  });

  it("returns null while the latest turn is still running", () => {
    expect(
      getCompletedPromptRound(
        makeThread({
          latestTurn: { turnId: "turn-2", state: "running", assistantMessageId: null },
        }),
      ),
    ).toBeNull();
  });

  it("returns null when the assistant reply is still streaming", () => {
    const thread = makeThread();
    const messages = thread.messages.map((message) =>
      message.id === "asst-2" ? { ...message, streaming: true } : message,
    );
    expect(getCompletedPromptRound({ ...thread, messages })).toBeNull();
  });

  it("returns null when there is no thread or no completed turn yet", () => {
    expect(getCompletedPromptRound(undefined)).toBeNull();
    expect(getCompletedPromptRound(makeThread({ latestTurn: null }))).toBeNull();
  });

  it("clamps oversized round text", () => {
    const thread = makeThread();
    const messages = thread.messages.map((message) =>
      message.id === "asst-2" ? { ...message, text: "z".repeat(10_000) } : message,
    );
    const round = getCompletedPromptRound({ ...thread, messages });
    expect(round?.assistantMessage.length).toBe(4_000);
  });
});
