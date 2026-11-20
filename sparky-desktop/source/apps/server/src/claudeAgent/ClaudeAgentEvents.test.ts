import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeAgentRequestType,
  makeClaudeAgentMapper,
  normalizeClaudeAgentToolName,
} from "./ClaudeAgentEvents.ts";

const asMessage = (value: unknown) => value as SDKMessage;

describe("normalizeClaudeAgentToolName", () => {
  it("strips the Sparky MCP prefix and maps built-in Claude Code tools", () => {
    expect(normalizeClaudeAgentToolName("mcp__sparky__html_render")).toBe("html_render");
    expect(normalizeClaudeAgentToolName("mcp__sparky__preview_open")).toBe("preview_open");
    expect(normalizeClaudeAgentToolName("Bash")).toBe("bash");
    expect(normalizeClaudeAgentToolName("MultiEdit")).toBe("edit");
    expect(normalizeClaudeAgentToolName("Glob")).toBe("find");
    expect(normalizeClaudeAgentToolName("TodoWrite")).toBe("update_plan");
    expect(normalizeClaudeAgentToolName("SomethingNew")).toBe("somethingnew");
  });
});

describe("claudeAgentRequestType", () => {
  it("routes approvals to the canonical request kinds", () => {
    expect(claudeAgentRequestType("Bash")).toBe("command_execution_approval");
    expect(claudeAgentRequestType("Write")).toBe("file_change_approval");
    expect(claudeAgentRequestType("Read")).toBe("file_read_approval");
    expect(claudeAgentRequestType("mcp__sparky__sparky_computer_use_call_tool")).toBe(
      "dynamic_tool_call",
    );
  });
});

describe("makeClaudeAgentMapper", () => {
  it("captures the session id from init and maps streamed text deltas", () => {
    const mapper = makeClaudeAgentMapper({ turnKey: "turn-1" });
    expect(
      mapper.map(
        asMessage({
          type: "system",
          subtype: "init",
          session_id: "sess-42",
          apiKeySource: "ANTHROPIC_API_KEY",
        }),
      ),
    ).toEqual([]);
    expect(mapper.sessionId()).toBe("sess-42");

    const started = mapper.map(
      asMessage({
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg-1" } },
      }),
    );
    expect(started).toEqual([]);

    const open = mapper.map(
      asMessage({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      }),
    );
    expect(open).toEqual([
      {
        type: "item.started",
        itemId: "msg-1:0",
        payload: { itemType: "assistant_message", status: "inProgress" },
      },
    ]);

    const delta = mapper.map(
      asMessage({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      }),
    );
    expect(delta).toEqual([
      {
        type: "content.delta",
        itemId: "msg-1:0",
        payload: { streamKind: "assistant_text", delta: "Hello" },
      },
    ]);
  });

  it("closes a streamed text segment with the full assistant text, without duplicating deltas", () => {
    const mapper = makeClaudeAgentMapper({ turnKey: "turn-2" });
    mapper.map(
      asMessage({
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg-2" } },
      }),
    );
    mapper.map(
      asMessage({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      }),
    );
    const drafts = mapper.map(
      asMessage({
        type: "assistant",
        message: { id: "msg-2", content: [{ type: "text", text: "Done." }] },
      }),
    );
    expect(drafts).toEqual([
      {
        type: "item.completed",
        itemId: "msg-2:0",
        payload: { itemType: "assistant_message", status: "completed", detail: "Done." },
      },
    ]);
  });

  it("emits a complete assistant text block when no stream events were seen", () => {
    const mapper = makeClaudeAgentMapper({ turnKey: "turn-3" });
    const drafts = mapper.map(
      asMessage({
        type: "assistant",
        message: { id: "msg-3", content: [{ type: "text", text: "Hi there" }] },
      }),
    );
    expect(drafts.map((draft) => draft.type)).toEqual([
      "item.started",
      "content.delta",
      "item.completed",
    ]);
    expect(drafts[1]?.payload).toEqual({ streamKind: "assistant_text", delta: "Hi there" });
  });

  it("starts tool items with Sparky presentation and completes them from tool_result", () => {
    const mapper = makeClaudeAgentMapper({ turnKey: "turn-4" });
    const started = mapper.map(
      asMessage({
        type: "assistant",
        message: {
          id: "msg-4",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__sparky__html_render",
              input: { html: "<div>chart</div>", title: "Sales", height: 300 },
            },
          ],
        },
      }),
    );
    expect(started).toHaveLength(1);
    const startedDraft = started[0];
    expect(startedDraft?.type).toBe("item.started");
    expect(startedDraft?.itemId).toBe("toolu_1");
    expect(startedDraft?.payload.title).toBe("Render visual reply");
    const data = startedDraft?.payload.data as Record<string, unknown>;
    expect(data.toolCallId).toBe("toolu_1");
    expect(data.toolName).toBe("html_render");
    // The chat's HtmlRenderCard reads the tool input from `rawInput`.
    expect((data.rawInput as Record<string, unknown>).html).toBe("<div>chart</div>");

    const completed = mapper.map(
      asMessage({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "Rendered" }],
            },
          ],
        },
      }),
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.type).toBe("item.completed");
    expect(completed[0]?.payload.status).toBe("completed");
    expect(completed[0]?.payload.data).toMatchObject({
      toolCallId: "toolu_1",
      result: { output: "Rendered", isError: false },
    });
  });

  it("marks failed tool results as failed", () => {
    const mapper = makeClaudeAgentMapper({ turnKey: "turn-5" });
    mapper.map(
      asMessage({
        type: "assistant",
        message: {
          id: "msg-5",
          content: [
            { type: "tool_use", id: "toolu_err", name: "Bash", input: { command: "exit 1" } },
          ],
        },
      }),
    );
    const completed = mapper.map(
      asMessage({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_err", content: "boom", is_error: true },
          ],
        },
      }),
    );
    expect(completed[0]?.payload.status).toBe("failed");
  });

  it("completes the turn from the result message and records the resume state", () => {
    const mapper = makeClaudeAgentMapper({ turnKey: "turn-6" });
    const drafts = mapper.map(
      asMessage({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-42",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        usage: { input_tokens: 10 },
        modelUsage: {},
        result: "ok",
      }),
    );
    // Usage on the result also feeds the context meter before the turn completes.
    expect(drafts.map((draft) => draft.type)).toEqual([
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(drafts[1]).toEqual({
      type: "turn.completed",
      payload: expect.objectContaining({ state: "completed", stopReason: "end_turn" }),
    });
    expect(mapper.result()?.state).toBe("completed");
    expect(mapper.result()?.sessionId).toBe("sess-42");
  });

  it("reports failed results with the error message", () => {
    const mapper = makeClaudeAgentMapper({ turnKey: "turn-7" });
    const drafts = mapper.map(
      asMessage({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        session_id: "sess-7",
        stop_reason: null,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        errors: ["Reached max turns"],
      }),
    );
    expect(drafts[0]?.payload).toMatchObject({
      state: "failed",
      errorMessage: "Reached max turns",
    });
  });
});
