import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeToolNameOf,
  makeClaudeAcpMapper,
  normalizeClaudeToolInput,
  normalizeClaudeToolName,
} from "./ClaudeAcpEvents.ts";

const text = (value: string) => ({ type: "text" as const, text: value });

describe("Claude tool names", () => {
  it("maps Sparky MCP tools and Claude Code built-ins to presentation names", () => {
    expect(normalizeClaudeToolName("mcp__sparky__html_render")).toBe("html_render");
    expect(normalizeClaudeToolName("Bash")).toBe("bash");
    expect(normalizeClaudeToolName("MultiEdit")).toBe("edit");
    expect(normalizeClaudeToolName("TodoWrite")).toBe("update_plan");
    expect(normalizeClaudeToolName("AskUserQuestion")).toBe("ask_user");
  });

  it("prefers the adapter's _meta tool name and falls back to the ACP kind", () => {
    expect(claudeToolNameOf({ _meta: { claudeCode: { toolName: "Edit" } }, title: "x" })).toBe(
      "Edit",
    );
    expect(claudeToolNameOf({ kind: "execute", title: "Run ls" })).toBe("Bash");
    expect(claudeToolNameOf({ kind: "search", title: "grep" })).toBe("Grep");
    expect(claudeToolNameOf({ title: "Custom tool" })).toBe("Custom tool");
  });

  it("adds diff fields to Edit and MultiEdit input so file-change rows show stats", () => {
    expect(normalizeClaudeToolInput("Edit", { old_string: "a", new_string: "b\nc" })).toMatchObject(
      {
        oldText: "a",
        newText: "b\nc",
      },
    );
    expect(
      normalizeClaudeToolInput("MultiEdit", { edits: [{ old_string: "x", new_string: "y" }] })
        .changes,
    ).toEqual([{ oldText: "x", newText: "y" }]);
  });
});

describe("makeClaudeAcpMapper", () => {
  it("streams assistant text into one message item and closes it on flush", () => {
    const mapper = makeClaudeAcpMapper({ turnKey: "turn-1" });
    const first = mapper.map({
      sessionUpdate: "agent_message_chunk",
      content: text("Hello "),
    } as SessionUpdate);
    const second = mapper.map({
      sessionUpdate: "agent_message_chunk",
      content: text("world"),
    } as SessionUpdate);
    expect(first.map((draft) => draft.type)).toEqual(["item.started", "content.delta"]);
    expect(second.map((draft) => draft.type)).toEqual(["content.delta"]);
    const itemId = first[0]?.itemId;
    expect(second[0]?.itemId).toBe(itemId);
    expect(mapper.flush()).toEqual([
      {
        type: "item.completed",
        itemId,
        payload: { itemType: "assistant_message", status: "completed" },
      },
    ]);
  });

  it("starts a tool item with presentation data and completes it with its output", () => {
    const mapper = makeClaudeAcpMapper({ turnKey: "turn-2" });
    const started = mapper.map({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read a.ts",
      kind: "read",
      status: "in_progress",
      rawInput: { file_path: "a.ts" },
      _meta: { claudeCode: { toolName: "Read" } },
    } as SessionUpdate);
    expect(started[0]).toMatchObject({ type: "item.started", itemId: "tool-1" });
    expect(started[0]?.payload).toMatchObject({ status: "inProgress" });

    const done = mapper.map({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{ type: "content", content: text("file body") }],
    } as SessionUpdate);
    expect(done[0]?.type).toBe("item.completed");
    expect(done[0]?.payload).toMatchObject({
      status: "completed",
      data: { toolCallId: "tool-1", result: { output: "file body", isError: false } },
    });
    expect(mapper.toolNameFor("tool-1")).toBeUndefined();
  });

  it("marks a failed tool update as failed", () => {
    const mapper = makeClaudeAcpMapper({ turnKey: "turn-3" });
    mapper.map({
      sessionUpdate: "tool_call",
      toolCallId: "tool-2",
      title: "Bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "false" },
    } as SessionUpdate);
    const failed = mapper.map({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-2",
      status: "failed",
    } as SessionUpdate);
    expect(failed[0]?.payload).toMatchObject({ status: "failed" });
  });

  it("maps plan entries to plan steps with Sparky's status names", () => {
    const mapper = makeClaudeAcpMapper({ turnKey: "turn-4" });
    const drafts = mapper.map({
      sessionUpdate: "plan",
      entries: [
        { content: "Read", priority: "high", status: "completed" },
        { content: "Fix", priority: "high", status: "in_progress" },
        { content: "Test", priority: "low", status: "pending" },
      ],
    } as SessionUpdate);
    expect(drafts[0]).toEqual({
      type: "turn.plan.updated",
      payload: {
        plan: [
          { step: "Read", status: "completed" },
          { step: "Fix", status: "inProgress" },
          { step: "Test", status: "pending" },
        ],
      },
    });
  });

  it("reports context usage from usage_update", () => {
    const mapper = makeClaudeAcpMapper({ turnKey: "turn-5" });
    const drafts = mapper.map({
      sessionUpdate: "usage_update",
      used: 1200,
      size: 200000,
    } as SessionUpdate);
    expect(drafts[0]).toEqual({
      type: "thread.token-usage.updated",
      payload: { usage: { usedTokens: 1200, lastUsedTokens: 1200, maxTokens: 200000 } },
    });
  });

  it("ignores updates that have no chat row", () => {
    const mapper = makeClaudeAcpMapper({ turnKey: "turn-6" });
    expect(
      mapper.map({
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      } as SessionUpdate),
    ).toEqual([]);
  });
});
