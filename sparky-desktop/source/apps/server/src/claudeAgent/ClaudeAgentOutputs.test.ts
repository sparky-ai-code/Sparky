import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeAgentTokenUsageSnapshot,
  makeClaudeAgentMapper,
  normalizeClaudeAgentToolInput,
  normalizeClaudeAgentToolName,
} from "./ClaudeAgentEvents.ts";

const asMessage = (value: unknown) => value as SDKMessage;

describe("Claude Code outputs", () => {
  it("maps AskUserQuestion to the chat's ask_user tool", () => {
    expect(normalizeClaudeAgentToolName("AskUserQuestion")).toBe("ask_user");
  });

  it("adds diff-stat fields to Edit input so file-change rows show added and removed lines", () => {
    const normalized = normalizeClaudeAgentToolInput("Edit", {
      file_path: "src/a.ts",
      old_string: "one\ntwo",
      new_string: "one\ntwo\nthree",
    });
    expect(normalized).toMatchObject({
      oldText: "one\ntwo",
      newText: "one\ntwo\nthree",
    });
  });

  it("maps MultiEdit edits to the chat's changes list", () => {
    const normalized = normalizeClaudeAgentToolInput("MultiEdit", {
      file_path: "src/a.ts",
      edits: [{ old_string: "a", new_string: "b" }],
    });
    expect(normalized.changes).toEqual([{ oldText: "a", newText: "b" }]);
  });

  it("emits a file-change item with diff stats for an Edit tool call", () => {
    const mapper = makeClaudeAgentMapper({ turnKey: "turn-edit" });
    const drafts = mapper.map(
      asMessage({
        type: "assistant",
        message: {
          id: "msg-edit",
          content: [
            {
              type: "tool_use",
              id: "toolu_edit",
              name: "Edit",
              input: {
                file_path: "src/a.ts",
                old_string: "old line",
                new_string: "new line\nextra",
              },
            },
          ],
        },
      }),
    );
    const started = drafts[0];
    expect(started?.payload.itemType).toBe("file_change");
    const rawInput = (started?.payload.data as { rawInput: Record<string, unknown> }).rawInput;
    expect(rawInput).toMatchObject({ oldText: "old line", newText: "new line\nextra" });
  });

  it("reports token usage on the result for the context meter", () => {
    const mapper = makeClaudeAgentMapper({ turnKey: "turn-usage" });
    const drafts = mapper.map(
      asMessage({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-usage",
        stop_reason: "end_turn",
        total_cost_usd: 0.02,
        usage: {
          input_tokens: 1200,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 100,
          output_tokens: 300,
        },
        modelUsage: {},
        result: "ok",
      }),
    );
    expect(drafts.map((draft) => draft.type)).toEqual([
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(drafts[0]?.payload).toEqual({
      usage: {
        usedTokens: 2400,
        lastUsedTokens: 2400,
        inputTokens: 1200,
        cachedInputTokens: 900,
        outputTokens: 300,
      },
    });
  });

  it("returns no token usage when the result carries none", () => {
    expect(claudeAgentTokenUsageSnapshot(undefined)).toBeUndefined();
    expect(claudeAgentTokenUsageSnapshot({})).toBeUndefined();
  });
});
