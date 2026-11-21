/**
 * Maps ACP `session/update` notifications from the Claude adapter to Sparky's
 * canonical runtime event drafts.
 *
 * The mapper is pure and keeps per-turn state (the open assistant message and the
 * open tool calls). The adapter stamps the event ids and publishes the drafts.
 *
 * @module claudeAcp/ClaudeAcpEvents
 */
import type { SessionUpdate, ToolCall, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk";

import { sparkyToolPresentation } from "../provider/Layers/SparkyAdapter.ts";

export interface ClaudeAcpEventDraft {
  readonly type:
    | "item.started"
    | "item.updated"
    | "item.completed"
    | "content.delta"
    | "turn.plan.updated"
    | "thread.token-usage.updated";
  readonly itemId?: string;
  readonly payload: Record<string, unknown>;
}

const MCP_PREFIX = "mcp__sparky__";

/**
 * Map a Claude Code tool name to the name Sparky's presentation table understands.
 * Sparky's own MCP tools arrive as `mcp__sparky__<name>`.
 */
export function normalizeClaudeToolName(toolName: string): string {
  if (toolName.startsWith(MCP_PREFIX)) return toolName.slice(MCP_PREFIX.length);
  const builtIn: Record<string, string> = {
    Bash: "bash",
    Read: "read",
    Write: "write",
    Edit: "edit",
    MultiEdit: "edit",
    Glob: "find",
    Grep: "grep",
    LS: "ls",
    WebSearch: "web_search",
    TodoWrite: "update_plan",
    AskUserQuestion: "ask_user",
  };
  return builtIn[toolName] ?? toolName.toLowerCase();
}

/** Tool name for a tool call: the adapter's `_meta` name when present, otherwise the ACP kind. */
export function claudeToolNameOf(input: {
  readonly title?: string | null | undefined;
  readonly kind?: ToolKind | null | undefined;
  readonly _meta?: unknown;
}): string {
  const meta = input._meta as { claudeCode?: { toolName?: unknown } } | null | undefined;
  const fromMeta = meta?.claudeCode?.toolName;
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  switch (input.kind) {
    case "execute":
      return "Bash";
    case "read":
      return "Read";
    case "edit":
    case "delete":
    case "move":
      return "Edit";
    case "search":
      return "Grep";
    case "fetch":
      return "WebSearch";
    default:
      return input.title?.trim() || "tool";
  }
}

/**
 * Add the field names Sparky's chat reads for diff statistics. Claude Code's Edit
 * uses `old_string`/`new_string` and MultiEdit uses `edits`, but the chat reads
 * `oldText`/`newText` and `changes`. The original fields are kept.
 */
export function normalizeClaudeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === "Edit") {
    return { ...input, oldText: input.old_string, newText: input.new_string };
  }
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    const changes = input.edits.map((edit) => {
      const record = (edit ?? {}) as Record<string, unknown>;
      return { oldText: record.old_string, newText: record.new_string };
    });
    return { ...input, changes };
  }
  return input;
}

function textOf(content: ToolCall["content"] | ToolCallUpdate["content"] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (item.type === "content" && item.content.type === "text") return item.content.text;
      if (item.type === "diff") return `Edited ${item.path}`;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function planStatus(status: string): "pending" | "inProgress" | "completed" {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "inProgress";
  return "pending";
}

interface TrackedTool {
  readonly toolName: string;
  readonly itemType: string;
  readonly title: string;
  readonly data: Record<string, unknown>;
}

export interface ClaudeAcpMapper {
  /** Map one session update. Returns drafts in publish order. */
  readonly map: (update: SessionUpdate) => ReadonlyArray<ClaudeAcpEventDraft>;
  /** Close the open assistant message and reasoning segment at the end of a turn. */
  readonly flush: () => ReadonlyArray<ClaudeAcpEventDraft>;
  /** The tool name recorded for a tool call, for permission requests. */
  readonly toolNameFor: (toolCallId: string) => string | undefined;
}

export function makeClaudeAcpMapper(input: { readonly turnKey: string }): ClaudeAcpMapper {
  let segmentCounter = 0;
  let openMessage: { readonly itemId: string } | undefined;
  let openThought: { readonly itemId: string } | undefined;
  const tools = new Map<string, TrackedTool>();

  const openSegment = (kind: "message" | "thought"): { readonly itemId: string } => {
    segmentCounter += 1;
    return { itemId: `${input.turnKey}:${kind}:${segmentCounter}` };
  };

  const closeMessage = (): ClaudeAcpEventDraft[] => {
    if (!openMessage) return [];
    const itemId = openMessage.itemId;
    openMessage = undefined;
    return [
      {
        type: "item.completed",
        itemId,
        payload: { itemType: "assistant_message", status: "completed" },
      },
    ];
  };

  const closeThought = (): ClaudeAcpEventDraft[] => {
    if (!openThought) return [];
    const itemId = openThought.itemId;
    openThought = undefined;
    return [
      {
        type: "item.completed",
        itemId,
        payload: { itemType: "reasoning", status: "completed" },
      },
    ];
  };

  return {
    toolNameFor: (toolCallId) => tools.get(toolCallId)?.toolName,
    flush: () => [...closeMessage(), ...closeThought()],
    map: (update) => {
      const drafts: ClaudeAcpEventDraft[] = [];
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          if (update.content.type !== "text") return drafts;
          drafts.push(...closeThought());
          if (!openMessage) {
            openMessage = openSegment("message");
            drafts.push({
              type: "item.started",
              itemId: openMessage.itemId,
              payload: { itemType: "assistant_message", status: "inProgress" },
            });
          }
          drafts.push({
            type: "content.delta",
            itemId: openMessage.itemId,
            payload: { streamKind: "assistant_text", delta: update.content.text },
          });
          return drafts;
        }
        case "agent_thought_chunk": {
          if (update.content.type !== "text") return drafts;
          drafts.push(...closeMessage());
          if (!openThought) {
            openThought = openSegment("thought");
            drafts.push({
              type: "item.started",
              itemId: openThought.itemId,
              payload: { itemType: "reasoning", status: "inProgress" },
            });
          }
          drafts.push({
            type: "content.delta",
            itemId: openThought.itemId,
            payload: { streamKind: "reasoning_text", delta: update.content.text },
          });
          return drafts;
        }
        case "tool_call": {
          drafts.push(...closeMessage(), ...closeThought());
          const toolName = claudeToolNameOf(update);
          const presentation = sparkyToolPresentation(
            normalizeClaudeToolName(toolName),
            normalizeClaudeToolInput(
              toolName,
              (update.rawInput as Record<string, unknown> | undefined) ?? {},
            ),
          );
          tools.set(update.toolCallId, {
            toolName,
            itemType: presentation.itemType,
            title: presentation.title,
            data: presentation.data,
          });
          drafts.push({
            type: "item.started",
            itemId: update.toolCallId,
            payload: {
              itemType: presentation.itemType,
              status: "inProgress",
              title: presentation.title,
              data: { ...presentation.data, toolCallId: update.toolCallId },
            },
          });
          return drafts;
        }
        case "tool_call_update": {
          const tracked = tools.get(update.toolCallId);
          const toolName = tracked?.toolName ?? claudeToolNameOf(update);
          const presentation = tracked ?? {
            toolName,
            itemType: sparkyToolPresentation(normalizeClaudeToolName(toolName), {}).itemType,
            title: sparkyToolPresentation(normalizeClaudeToolName(toolName), {}).title,
            data: {},
          };
          if (update.status === "completed" || update.status === "failed") {
            tools.delete(update.toolCallId);
            drafts.push({
              type: "item.completed",
              itemId: update.toolCallId,
              payload: {
                itemType: presentation.itemType,
                status: update.status === "failed" ? "failed" : "completed",
                title: presentation.title,
                data: {
                  ...presentation.data,
                  toolCallId: update.toolCallId,
                  result: { output: textOf(update.content), isError: update.status === "failed" },
                },
              },
            });
          } else {
            drafts.push({
              type: "item.updated",
              itemId: update.toolCallId,
              payload: {
                itemType: presentation.itemType,
                status: "inProgress",
                title: presentation.title,
                data: { ...presentation.data, toolCallId: update.toolCallId },
              },
            });
          }
          return drafts;
        }
        case "plan": {
          drafts.push(...closeMessage());
          drafts.push({
            type: "turn.plan.updated",
            payload: {
              plan: update.entries.map((entry) => ({
                step: entry.content,
                status: planStatus(entry.status),
              })),
            },
          });
          return drafts;
        }
        case "usage_update": {
          drafts.push({
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens: Math.max(0, Math.round(update.used)),
                lastUsedTokens: Math.max(0, Math.round(update.used)),
                maxTokens: Math.max(1, Math.round(update.size)),
              },
            },
          });
          return drafts;
        }
        default:
          // user echoes, commands, modes, and config updates have no chat row.
          return drafts;
      }
    },
  };
}
