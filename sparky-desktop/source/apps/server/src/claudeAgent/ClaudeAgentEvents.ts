/**
 * Maps Claude Agent SDK messages to Sparky's canonical runtime event drafts.
 *
 * The mapper is pure: it keeps per-turn state (open text segments and tool calls)
 * and returns event drafts. The adapter stamps eventId, thread and turn ids and
 * publishes them, so the existing orchestration ingestion and chat timeline code
 * is reused unchanged.
 *
 * @module claudeAgent/ClaudeAgentEvents
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ToolLifecycleItemType } from "@sparky/contracts";

import { sparkyToolPresentation } from "../provider/Layers/SparkyAdapter.ts";
import { SPARKY_MCP_SERVER_NAME } from "./ClaudeAgentOptions.ts";

export interface ClaudeAgentEventDraft {
  readonly type:
    | "item.started"
    | "item.completed"
    | "content.delta"
    | "turn.completed"
    | "request.opened"
    | "request.resolved"
    | "thread.token-usage.updated"
    | "turn.plan.updated"
    | "turn.proposed.completed"
    | "runtime.error"
    | "runtime.warning";
  readonly itemId?: string;
  readonly payload: Record<string, unknown>;
}

export interface ClaudeAgentTurnResult {
  readonly sessionId?: string | undefined;
  readonly state: "completed" | "failed";
  readonly stopReason?: string | null | undefined;
  readonly errorMessage?: string | undefined;
  readonly totalCostUsd?: number | undefined;
  readonly usage?: unknown;
  readonly modelUsage?: Record<string, unknown> | undefined;
}

/**
 * Map a Claude Code tool name to the name Sparky's presentation table understands.
 * Sparky's own MCP tools are exposed as `mcp__sparky__<name>`; built-in Claude Code
 * tools use PascalCase names.
 */
export function normalizeClaudeAgentToolName(toolName: string): string {
  const mcpPrefix = `mcp__${SPARKY_MCP_SERVER_NAME}__`;
  if (toolName.startsWith(mcpPrefix)) return toolName.slice(mcpPrefix.length);
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

/**
 * Add the field names Sparky's chat reads for diff statistics. Claude Code's Edit
 * uses `old_string`/`new_string` and MultiEdit uses `edits`, but the chat reads
 * `oldText`/`newText` and `changes`. The original fields are kept.
 */
export function normalizeClaudeAgentToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === "Edit") {
    return {
      ...input,
      oldText: input.old_string,
      newText: input.new_string,
    };
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

/**
 * Convert a TodoWrite todo list into Sparky's plan steps. Claude Code uses
 * `in_progress`; Sparky's plan panel uses `inProgress`.
 */
export function claudeAgentPlanSteps(
  todos: unknown,
): ReadonlyArray<{ step: string; status: "pending" | "inProgress" | "completed" }> {
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((todo) => {
    const record = (todo ?? {}) as Record<string, unknown>;
    const step = String(record.content ?? "").trim();
    if (step.length === 0) return [];
    const status =
      record.status === "completed"
        ? "completed"
        : record.status === "in_progress"
          ? "inProgress"
          : "pending";
    return [{ step, status }];
  });
}

/** Token usage for the context meter, from the SDK's per-turn result usage. */
export function claudeAgentTokenUsageSnapshot(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const count = (key: string) => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  };
  const inputTokens = count("input_tokens");
  const cachedInputTokens = count("cache_read_input_tokens") + count("cache_creation_input_tokens");
  const outputTokens = count("output_tokens");
  // The prompt size of the last request is what fills the context window.
  const promptTokens = inputTokens + cachedInputTokens;
  if (promptTokens === 0 && outputTokens === 0) return undefined;
  return {
    usedTokens: promptTokens + outputTokens,
    lastUsedTokens: promptTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

/** Which canonical approval kind a Claude Code tool request maps to. */
export function claudeAgentRequestType(
  toolName: string,
):
  | "command_execution_approval"
  | "file_change_approval"
  | "file_read_approval"
  | "dynamic_tool_call" {
  switch (toolName) {
    case "Bash":
      return "command_execution_approval";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "file_change_approval";
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
      return "file_read_approval";
    default:
      return "dynamic_tool_call";
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

interface OpenSegment {
  readonly itemId: string;
  text: string;
}

export interface ClaudeAgentMapper {
  /** Map one SDK message. Returns drafts in the order they should be published. */
  readonly map: (message: SDKMessage) => ReadonlyArray<ClaudeAgentEventDraft>;
  /** Result of the terminal `result` message, once received. */
  readonly result: () => ClaudeAgentTurnResult | undefined;
  /** Session id reported by the SDK's `system.init` message. */
  readonly sessionId: () => string | undefined;
}

export function makeClaudeAgentMapper(input: { readonly turnKey: string }): ClaudeAgentMapper {
  let currentMessageId = input.turnKey;
  let sessionId: string | undefined;
  let finalResult: ClaudeAgentTurnResult | undefined;
  const openSegments = new Map<number, OpenSegment>();
  const tools = new Map<
    string,
    {
      readonly itemType: ToolLifecycleItemType;
      readonly title: string;
      readonly data: Record<string, unknown>;
    }
  >();

  const started = (itemId: string, itemType: string, title?: string): ClaudeAgentEventDraft => ({
    type: "item.started",
    itemId,
    payload: {
      itemType,
      status: "inProgress",
      ...(title ? { title } : {}),
    },
  });

  return {
    sessionId: () => sessionId,
    result: () => finalResult,
    map: (message) => {
      const drafts: ClaudeAgentEventDraft[] = [];
      switch (message.type) {
        case "system": {
          if (message.subtype === "init") sessionId = message.session_id;
          return drafts;
        }
        case "stream_event": {
          const event = message.event as unknown as {
            type: string;
            index?: number;
            message?: { id?: string };
            content_block?: { type?: string };
            delta?: { type?: string; text?: string };
          };
          if (event.type === "message_start" && event.message?.id) {
            currentMessageId = event.message.id;
          } else if (event.type === "content_block_start" && event.content_block?.type === "text") {
            const index = event.index ?? 0;
            const segment = { itemId: `${currentMessageId}:${index}`, text: "" };
            openSegments.set(index, segment);
            drafts.push(started(segment.itemId, "assistant_message"));
          } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            const index = event.index ?? 0;
            const segment = openSegments.get(index);
            const delta = event.delta.text ?? "";
            if (segment && delta.length > 0) {
              segment.text += delta;
              drafts.push({
                type: "content.delta",
                itemId: segment.itemId,
                payload: { streamKind: "assistant_text", delta },
              });
            }
          }
          return drafts;
        }
        case "assistant": {
          const blocks = message.message.content as unknown as ReadonlyArray<
            Record<string, unknown>
          >;
          blocks.forEach((block, index) => {
            if (block.type === "text") {
              const text = String(block.text ?? "");
              const segment = openSegments.get(index);
              const itemId = segment?.itemId ?? `${message.message.id}:${index}`;
              if (!segment) {
                drafts.push(started(itemId, "assistant_message"));
                if (text.length > 0) {
                  drafts.push({
                    type: "content.delta",
                    itemId,
                    payload: { streamKind: "assistant_text", delta: text },
                  });
                }
              }
              openSegments.delete(index);
              drafts.push({
                type: "item.completed",
                itemId,
                payload: { itemType: "assistant_message", status: "completed", detail: text },
              });
            } else if (block.type === "tool_use") {
              const toolName = String(block.name ?? "tool");
              const toolCallId = String(block.id ?? `${message.message.id}:tool:${index}`);
              const normalized = normalizeClaudeAgentToolName(toolName);
              const presentation = sparkyToolPresentation(
                normalized,
                normalizeClaudeAgentToolInput(
                  toolName,
                  (block.input as Record<string, unknown> | undefined) ?? {},
                ),
              );
              tools.set(toolCallId, presentation);
              drafts.push({
                type: "item.started",
                itemId: toolCallId,
                payload: {
                  itemType: presentation.itemType,
                  status: "inProgress",
                  title: presentation.title,
                  data: { ...presentation.data, toolCallId },
                },
              });
              if (toolName === "TodoWrite") {
                const todos = (block.input as Record<string, unknown> | undefined)?.todos;
                drafts.push({
                  type: "turn.plan.updated",
                  payload: { plan: claudeAgentPlanSteps(todos) },
                });
              }
            }
          });
          return drafts;
        }
        case "user": {
          const content = message.message.content;
          if (!Array.isArray(content)) return drafts;
          for (const block of content as unknown as ReadonlyArray<Record<string, unknown>>) {
            if (block.type !== "tool_result") continue;
            const toolCallId = String(block.tool_use_id ?? "");
            const presentation = tools.get(toolCallId);
            tools.delete(toolCallId);
            const isError = block.is_error === true;
            drafts.push({
              type: "item.completed",
              itemId: toolCallId,
              payload: {
                itemType: presentation?.itemType ?? "dynamic_tool_call",
                status: isError ? "failed" : "completed",
                title: presentation?.title ?? "Tool",
                data: {
                  ...(presentation?.data ?? {}),
                  toolCallId,
                  result: { output: toolResultText(block.content), isError },
                },
              },
            });
          }
          return drafts;
        }
        case "result": {
          const isSuccess = message.subtype === "success" && !message.is_error;
          const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
          finalResult = {
            sessionId: message.session_id,
            state: isSuccess ? "completed" : "failed",
            stopReason: message.stop_reason,
            ...(isSuccess
              ? {}
              : {
                  errorMessage:
                    errors.length > 0
                      ? errors.map(String).join("; ")
                      : `Claude Code stopped: ${message.subtype}`,
                }),
            totalCostUsd: message.total_cost_usd,
            usage: message.usage,
            modelUsage: message.modelUsage as Record<string, unknown>,
          };
          const tokenUsage = claudeAgentTokenUsageSnapshot(message.usage);
          if (tokenUsage) {
            drafts.push({
              type: "thread.token-usage.updated",
              payload: { usage: tokenUsage },
            });
          }
          drafts.push({
            type: "turn.completed",
            payload: {
              state: finalResult.state,
              stopReason: finalResult.stopReason,
              usage: finalResult.usage,
              modelUsage: finalResult.modelUsage,
              totalCostUsd: finalResult.totalCostUsd,
              ...(finalResult.errorMessage ? { errorMessage: finalResult.errorMessage } : {}),
            },
          });
          return drafts;
        }
        default:
          return drafts;
      }
    },
  };
}
