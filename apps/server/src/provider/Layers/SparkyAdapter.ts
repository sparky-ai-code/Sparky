// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type ToolLifecycleItemType,
  TurnId,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderWorkspaceContext,
} from "@sparky/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { getModelSelectionStringOptionValue } from "@sparky/shared/model";
import { errorTag } from "@sparky/shared/observability";
import {
  isCodexOAuthModel,
  normalizeCodexOAuthEffectiveContextWindowTokens,
} from "../codexContextWindow.ts";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("sparky");
const T3_MCP_BEARER_TOKEN_ENV_VAR = "T3_MCP_BEARER_TOKEN";
const HIDDEN_SPARKY_CONTROL_TOOLS = new Set(["end_task"]);
const SPARKY_BROWSER_INSTRUCTIONS = `You are running inside Sparky Desktop. The t3-code MCP tools named preview_* control the collaborative browser shared with the user.
For browser work, first call preview_status. If no automation-capable preview is attached, call preview_open. Then use preview_navigate, preview_snapshot, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.
Do not open the user's external browser or start a replacement browser automation stack when the preview_* tools are available.`;

// Stream callbacks are synchronous by contract, so publish their events with
// a small module-level runner rather than nesting Effect.runSync in the turn
// effect. This keeps callback ordering while satisfying Effect diagnostics.
function runEffectSync(effect: Effect.Effect<void>): void {
  Effect.runSync(effect);
}

export interface SparkyAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly attachmentsDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
  readonly getCustomInstructions?: (() => Effect.Effect<string>) | undefined;
}

export interface SparkyProcessResult {
  readonly response: string;
  readonly sessionId?: string | undefined;
}

export interface SparkyToolStartedEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
}

export interface SparkyToolCompletedEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: string;
  readonly isError: boolean;
}

export interface SparkyUsageEvent {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cumulativeTotalTokens: number;
}

export interface SparkyStreamCallbacks {
  readonly onDelta?: ((delta: string) => void) | undefined;
  readonly onSessionId?: ((sessionId: string) => void) | undefined;
  readonly onToolStarted?: ((event: SparkyToolStartedEvent) => void) | undefined;
  readonly onToolCompleted?: ((event: SparkyToolCompletedEvent) => void) | undefined;
  readonly onUsage?: ((event: SparkyUsageEvent) => void) | undefined;
  /** Fired as soon as the terminal JSON result frame is received. */
  readonly onResult?: ((result: SparkyProcessResult) => void) | undefined;
}

export interface SparkyAssistantSegmentCallbacks {
  readonly onStarted: (segmentId: string) => void;
  readonly onDelta: (segmentId: string, delta: string) => void;
  readonly onCompleted: (segmentId: string, text: string) => void;
}

// Maximum period without provider stdout/stderr activity before we kill one
// Sparky process attempt. This is deliberately an inactivity timeout, not a
// total-turn timeout: slow networks and long tool calls are allowed to make
// progress without being killed merely because the turn is old.
export const SPARKY_TURN_IDLE_TIMEOUT_MS = Duration.toMillis(Duration.minutes(10));
export const SPARKY_RECONNECT_RETRY_COUNT = 5;
const SPARKY_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const isSparkyProcessError = Schema.is(ProviderAdapterProcessError);

const RETRYABLE_SPARKY_ERROR_MARKERS = [
  "stalled",
  "timed out",
  "timeout",
  "econnreset",
  "econnrefused",
  "etimedout",
  "unable to reach",
  "error sending request",
  "fetch failed",
  "network",
  "socket",
  "connection",
  "temporarily unavailable",
  "rate limit",
  "status 429",
  "status 502",
  "status 503",
  "status 504",
] as const;

const NON_RETRYABLE_SPARKY_ERROR_MARKERS = [
  "unsupported parameter",
  "invalid value",
  "invalid api key",
  "unauthorized",
  "forbidden",
  "freeusagelimit",
  "free usage limit",
  "context_length_exceeded",
  "context window",
] as const;

export function isRetryableSparkyProcessError(error: unknown): boolean {
  if (!isSparkyProcessError(error)) {
    return false;
  }

  const detail = error.detail.toLowerCase();
  if (NON_RETRYABLE_SPARKY_ERROR_MARKERS.some((marker) => detail.includes(marker))) {
    return false;
  }
  return RETRYABLE_SPARKY_ERROR_MARKERS.some((marker) => detail.includes(marker));
}

function sanitizeSparkyLogDetail(value: string): string {
  return value
    .replace(
      /((?:api[_-]?key|authorization|bearer|token|password|secret)\s*[:=]\s*)([^\s,;]+)/giu,
      "$1<redacted>",
    )
    .slice(0, 1_000);
}

export function formatSparkyProcessError(
  cause: unknown,
  workspaceContext: ProviderWorkspaceContext | undefined,
): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (/freeusagelimit|free usage limit/iu.test(detail)) {
    if (/opencode api error/iu.test(detail)) {
      return "OpenCode Zen reported that this model's free usage limit was reached. Select another model or try again later.";
    }
    return "The selected provider model has reached its free usage limit. Select another model or try again later.";
  }
  if (
    workspaceContext === "none" &&
    /unexpected argument[\s\S]*--no-workspace-context/iu.test(detail)
  ) {
    return "The configured Sparky runtime is outdated and does not support project-free chats. Rebuild or update the Sparky binary, then retry.";
  }
  return detail;
}

export function isHiddenSparkyControlTool(toolName: string): boolean {
  return HIDDEN_SPARKY_CONTROL_TOOLS.has(toolName);
}

interface SessionState {
  session: ProviderSession;
  /** Internal process/session home; never exposed as ProviderSession.cwd. */
  runtimeCwd: string;
  snapshot: ProviderThreadSnapshot;
  nextTurn: number;
}

type SparkyChildProcess = ReturnType<typeof NodeChildProcess.spawn>;

export function makeSparkyStreamDecoder(callbacks: SparkyStreamCallbacks = {}) {
  let stdoutBuffer = "";
  let result: SparkyProcessResult | undefined;
  let protocolError: Error | undefined;
  const activeTools = new Map<string, { readonly toolName: string }>();

  const failOpenTools = (reason: string) => {
    for (const [toolCallId, tool] of activeTools) {
      callbacks.onToolCompleted?.({
        toolCallId,
        toolName: tool.toolName,
        output: reason,
        isError: true,
      });
    }
    activeTools.clear();
  };

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed) as {
        type?: unknown;
        delta?: unknown;
        response?: unknown;
        sessionId?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
        arguments?: unknown;
        output?: unknown;
        isError?: unknown;
        promptTokens?: unknown;
        completionTokens?: unknown;
        totalTokens?: unknown;
        cumulativeTotalTokens?: unknown;
      };
      const setProtocolError = (message: string) => {
        protocolError ??= new Error(message);
      };
      if (event.type === "delta") {
        if (typeof event.delta !== "string") {
          setProtocolError("Sparky returned a malformed text delta event.");
          return;
        }
        callbacks.onDelta?.(event.delta);
        return;
      }
      if (event.type === "thinking_delta") {
        if (typeof event.delta !== "string") {
          setProtocolError("Sparky returned a malformed thinking delta event.");
        }
        return;
      }
      if (event.type === "session") {
        if (typeof event.sessionId !== "string") {
          setProtocolError("Sparky returned a malformed session event.");
          return;
        }
        callbacks.onSessionId?.(event.sessionId);
        return;
      }
      if (event.type === "tool.started") {
        if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") {
          setProtocolError("Sparky returned a malformed tool.started event.");
          return;
        }
        activeTools.set(event.toolCallId, { toolName: event.toolName });
        callbacks.onToolStarted?.({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.arguments,
        });
        return;
      }
      if (event.type === "usage") {
        if (
          typeof event.promptTokens !== "number" ||
          typeof event.completionTokens !== "number" ||
          typeof event.totalTokens !== "number" ||
          typeof event.cumulativeTotalTokens !== "number"
        ) {
          setProtocolError("Sparky returned a malformed usage event.");
          return;
        }
        callbacks.onUsage?.({
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
          cumulativeTotalTokens: event.cumulativeTotalTokens,
        });
        return;
      }
      if (event.type === "tool.completed") {
        if (
          typeof event.toolCallId !== "string" ||
          typeof event.toolName !== "string" ||
          typeof event.output !== "string" ||
          typeof event.isError !== "boolean"
        ) {
          setProtocolError("Sparky returned a malformed tool.completed event.");
          return;
        }
        activeTools.delete(event.toolCallId);
        callbacks.onToolCompleted?.({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
          isError: event.isError,
        });
        return;
      }
      if (event.type === "result") {
        if (typeof event.response !== "string") {
          setProtocolError("Sparky returned a malformed result event.");
          return;
        }
        result = {
          response: event.response,
          ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {}),
        };
        callbacks.onResult?.(result);
        return;
      }
      setProtocolError(`Sparky returned an unknown streaming event '${String(event.type)}'.`);
    } catch (cause) {
      protocolError ??= new Error("Sparky returned an invalid streaming event.", { cause });
    }
  };

  return {
    hasOpenTools(): boolean {
      return activeTools.size > 0;
    },
    push(chunk: string): void {
      stdoutBuffer += chunk;
      let lineEnd = stdoutBuffer.indexOf("\n");
      while (lineEnd >= 0) {
        const line = stdoutBuffer.slice(0, lineEnd);
        stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
        processLine(line);
        // A result frame is terminal. Do not let data after it be interpreted
        // as another part of the completed turn while the child is shutting
        // down.
        if (result) {
          stdoutBuffer = "";
          break;
        }
        lineEnd = stdoutBuffer.indexOf("\n");
      }
    },
    failOpenTools,
    finish(): SparkyProcessResult {
      // Clear the pending buffer before parsing it. `onResult` is allowed to
      // call finish synchronously, so leaving the same line in the buffer
      // would parse the terminal result recursively.
      if (!result && stdoutBuffer.trim().length > 0) {
        const pending = stdoutBuffer;
        stdoutBuffer = "";
        processLine(pending);
      }
      if (protocolError) {
        failOpenTools(protocolError.message);
        throw protocolError;
      }
      if (!result || result.response.trim().length === 0) {
        failOpenTools("Sparky ended before this tool returned a result.");
        throw new Error("Sparky returned an empty streaming result.");
      }
      if (activeTools.size > 0) {
        const error = new Error("Sparky ended before this tool returned a result.");
        protocolError ??= error;
        failOpenTools(error.message);
        throw protocolError;
      }
      return result;
    },
  };
}

export function makeSparkyAssistantSegmenter(
  callbacks: SparkyAssistantSegmentCallbacks,
  makeSegmentId: () => string = NodeCrypto.randomUUID,
) {
  let activeSegment: { readonly id: string; text: string } | undefined;
  let sawText = false;

  const closeActiveSegment = () => {
    if (!activeSegment) return;
    callbacks.onCompleted(activeSegment.id, activeSegment.text);
    activeSegment = undefined;
  };

  const pushDelta = (delta: string) => {
    if (delta.length === 0) return;
    if (!activeSegment) {
      activeSegment = { id: makeSegmentId(), text: "" };
      callbacks.onStarted(activeSegment.id);
    }
    activeSegment.text += delta;
    sawText = true;
    callbacks.onDelta(activeSegment.id, delta);
  };

  return {
    pushDelta,
    closeBeforeTool: closeActiveSegment,
    finish(fallbackText: string): void {
      if (activeSegment) {
        closeActiveSegment();
        return;
      }
      if (!sawText && fallbackText.length > 0) {
        pushDelta(fallbackText);
        closeActiveSegment();
      }
    },
  };
}

function humanizeSparkyToolName(toolName: string): string {
  const words = toolName
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[._:-]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
  return words.length > 0
    ? words
        .map((word) => {
          const lower = word.toLowerCase();
          if (lower === "api") return "API";
          if (lower === "mcp") return "MCP";
          if (lower === "url") return "URL";
          return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
        })
        .join(" ")
    : "Tool";
}

export function sparkyToolPresentation(
  toolName: string,
  argumentsValue: unknown,
): {
  readonly itemType: ToolLifecycleItemType;
  readonly title: string;
  readonly data: Record<string, unknown>;
} {
  const normalizedName = toolName.trim().toLowerCase();
  const rawInput =
    argumentsValue !== null && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
      ? (argumentsValue as Record<string, unknown>)
      : {};
  const pluginId =
    normalizedName === "sparky_plugin_call" &&
    typeof rawInput.pluginId === "string" &&
    rawInput.pluginId.trim().length > 0
      ? rawInput.pluginId.trim().toLowerCase()
      : undefined;
  const isBrowserTool = normalizedName.startsWith("preview_");
  const itemType: ToolLifecycleItemType =
    normalizedName === "bash"
      ? "command_execution"
      : normalizedName === "write" || normalizedName === "edit"
        ? "file_change"
        : normalizedName === "web_search"
          ? "web_search"
          : isBrowserTool
            ? "mcp_tool_call"
            : "dynamic_tool_call";
  const kind =
    normalizedName === "bash"
      ? "execute"
      : normalizedName === "grep" || normalizedName === "find"
        ? "search"
        : normalizedName;
  const titleByName: Record<string, string> = {
    ask_user: "Ask user",
    bash: "Terminal",
    edit: "Edit file",
    find: "Find",
    grep: "Grep",
    ls: "List files",
    memory_add: "Save memory",
    memory_delete: "Forget memory",
    memory_search: "Search memory",
    memory_update: "Update memory",
    read: "Read file",
    web_search: "Search the web",
    update_plan: "Update plan",
    write: "Write file",
    preview_status: "Get browser status",
    preview_open: "Open browser",
    preview_navigate: "Navigate browser",
    preview_resize: "Resize browser",
    preview_snapshot: "Inspect browser page",
    preview_click: "Click browser",
    preview_type: "Type in browser",
    preview_press: "Press key in browser",
    preview_scroll: "Scroll browser",
    preview_evaluate: "Evaluate browser JavaScript",
    preview_wait_for: "Wait for browser",
    preview_recording_start: "Start browser recording",
    preview_recording_stop: "Stop browser recording",
    sparky_list_projects: "List projects",
    sparky_list_threads: "List threads",
    sparky_list_models: "List models",
    sparky_set_model: "Set model",
    sparky_create_thread: "Create thread",
    sparky_send_message: "Send thread message",
  };
  return {
    itemType,
    title: titleByName[normalizedName] ?? humanizeSparkyToolName(toolName),
    data: {
      kind,
      toolName,
      rawInput,
      ...(pluginId ? { pluginId } : {}),
      ...(typeof rawInput.command === "string" ? { command: rawInput.command } : {}),
    },
  };
}

export function parseSparkyModelSelection(model: string | undefined): {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string | undefined;
} {
  const selected = model?.trim() || "GPT-5.6 Sol";
  const slash = selected.indexOf("/");
  if (slash <= 0 || slash === selected.length - 1) {
    return { provider: "openai", model: selected };
  }
  const provider = selected.slice(0, slash);
  const modelId = selected.slice(slash + 1);
  if (provider === "google") {
    return { provider: "gemini", model: modelId };
  }
  if (provider === "opencode") {
    return {
      provider: "opencode",
      model: modelId,
      baseUrl: "https://opencode.ai/zen/v1",
    };
  }
  return { provider, model: modelId };
}

export function parseSparkyContextWindowTokens(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replaceAll(",", "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)(?:\s*(tokens?|k|m|b))?$/u);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2] ?? "";
  const multiplier = unit.startsWith("b")
    ? 1_000_000_000
    : unit === "m"
      ? 1_000_000
      : unit === "k"
        ? 1_000
        : 1;
  const tokens = amount * multiplier;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

export function normalizeSparkyContextWindow(
  model: string,
  value: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isCodexOAuthModel(model)) return value;
  const requestedTokens = parseSparkyContextWindowTokens(value);
  const effectiveTokens = normalizeCodexOAuthEffectiveContextWindowTokens(
    model,
    requestedTokens,
    environment,
  );
  if (effectiveTokens === undefined) return undefined;
  if (effectiveTokens % 1_000_000 === 0) return `${effectiveTokens / 1_000_000}m`;
  if (effectiveTokens % 1_000 === 0) return `${effectiveTokens / 1_000}k`;
  return `${effectiveTokens}`;
}

/**
 * Models.dev can describe a model when the provider has not exposed a
 * capability yet. Keep that fallback visible for non-OAuth providers, but use
 * the account-safe Codex OAuth fallback in the runtime even when the catalog
 * only supplied Models.dev metadata.
 */
export function resolveSparkyRuntimeContextWindow(
  model: string,
  selection: ModelSelection | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (selection?.contextWindowSource === "models.dev" && !isCodexOAuthModel(model)) {
    return undefined;
  }
  return normalizeSparkyContextWindow(
    model,
    selection ? getModelSelectionStringOptionValue(selection, "contextWindow") : undefined,
    environment,
  );
}

const SPARKY_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Project-free chats still need a stable process/session home for Sparky's
 * durable transcript, but that home must never be the user's project or the
 * server process CWD.
 */
function projectFreeRuntimeCwd(attachmentsDir: string, threadId: string): string {
  const threadKey = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 32);
  const cwd = NodePath.join(attachmentsDir, "project-free", threadKey);
  NodeFS.mkdirSync(cwd, { recursive: true });
  return cwd;
}

function sparkySessionFile(cwd: string, sessionId: string): string {
  return NodePath.join(cwd, ".sparky", "sessions", `${sessionId}.jsonl`);
}

function usableSparkySessionId(cwd: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !SPARKY_SESSION_ID_PATTERN.test(value)) return undefined;
  return NodeFS.existsSync(sparkySessionFile(cwd, value)) ? value : undefined;
}

function sessionBindingFile(cwd: string, threadId: string): string {
  const bindingId = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
  return NodePath.join(cwd, ".sparky", "t3-sessions", `${bindingId}.json`);
}

export function readSparkySessionBinding(cwd: string, threadId: string): string | undefined {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(sessionBindingFile(cwd, threadId), "utf8")) as {
      version?: unknown;
      threadId?: unknown;
      sparkySessionId?: unknown;
    };
    if (parsed.version !== 1 || parsed.threadId !== threadId) return undefined;
    return usableSparkySessionId(cwd, parsed.sparkySessionId);
  } catch {
    return undefined;
  }
}

/** Ensure runtime session files stay out of ordinary working-tree changes. */
function ensureSparkyGitignored(cwd: string): void {
  const gitignorePath = NodePath.join(cwd, ".gitignore");
  const sparkyEntry = "/.sparky/";

  let content: string;
  try {
    content = NodeFS.readFileSync(gitignorePath, "utf8");
  } catch {
    // No .gitignore yet — create one.
    NodeFS.writeFileSync(gitignorePath, `${sparkyEntry}\n`, "utf8");
    return;
  }

  const hasEntry = content.split("\n").some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === sparkyEntry ||
      trimmed === "/.sparky" ||
      trimmed === ".sparky/" ||
      trimmed === ".sparky"
    );
  });

  if (!hasEntry) {
    NodeFS.writeFileSync(gitignorePath, `${content.trimEnd()}\n${sparkyEntry}\n`, "utf8");
  }
}

export function writeSparkySessionBinding(cwd: string, threadId: string, sessionId: string): void {
  if (!usableSparkySessionId(cwd, sessionId)) {
    throw new Error(`Cannot bind missing Sparky session '${sessionId}'.`);
  }
  const bindingDirectory = NodePath.join(cwd, ".sparky", "t3-sessions");
  const bindingFile = sessionBindingFile(cwd, threadId);
  NodeFS.mkdirSync(bindingDirectory, { recursive: true });
  ensureSparkyGitignored(cwd);
  const temporaryFile = `${bindingFile}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(
    temporaryFile,
    `${JSON.stringify({ version: 1, threadId, sparkySessionId: sessionId })}\n`,
    "utf8",
  );
  NodeFS.renameSync(temporaryFile, bindingFile);
}

export function captureSparkySessionIdentity(
  state: { session: ProviderSession },
  cwd: string,
  threadId: ThreadId,
  sessionId: string,
): void {
  state.session = {
    ...state.session,
    resumeCursor: {
      threadId: String(threadId),
      sparkySessionId: sessionId,
      ...(state.session.workspaceContext === "none" ? {} : { cwd }),
    },
    updatedAt: new Date().toISOString(),
  };
  writeSparkySessionBinding(cwd, String(threadId), sessionId);
}

function sparkySessionIdFromResumeCursor(value: unknown, threadId: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cursor = value as { threadId?: unknown; sparkySessionId?: unknown };
  if (cursor.threadId !== threadId) return undefined;
  return typeof cursor.sparkySessionId === "string" ? cursor.sparkySessionId : undefined;
}

function cwdFromResumeCursor(value: unknown, threadId: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cursor = value as { threadId?: unknown; cwd?: unknown };
  if (cursor.threadId !== threadId || typeof cursor.cwd !== "string") return undefined;
  const cwd = cursor.cwd.trim();
  return cwd.length > 0 ? cwd : undefined;
}

function sessionIdFromResumeCursor(
  cwd: string,
  threadId: string,
  resumeCursor: unknown,
): string | undefined {
  const sessionId = sparkySessionIdFromResumeCursor(resumeCursor, threadId);
  return sessionId ? usableSparkySessionId(cwd, sessionId) : undefined;
}

/** Resolve the conversation identity for every follow-up turn. */
export function resolveSparkySessionId(
  cwd: string,
  threadId: string,
  resumeCursor: unknown,
  workspaceContext: ProviderWorkspaceContext = "project",
): string | undefined {
  const requestedSessionId = sparkySessionIdFromResumeCursor(resumeCursor, threadId);
  if (requestedSessionId && !usableSparkySessionId(cwd, requestedSessionId)) {
    throw new Error(
      workspaceContext === "none"
        ? `Cannot continue Sparky conversation '${threadId}': the persisted session is missing.`
        : `Cannot continue Sparky conversation '${threadId}': persisted session '${requestedSessionId}' is missing from '${cwd}'. Refusing to start a new conversation.`,
    );
  }
  return requestedSessionId ?? readSparkySessionBinding(cwd, threadId);
}

export function makeSparkyProcessArgs(input: {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly textOnly?: boolean | undefined;
  readonly images?: ReadonlyArray<{ readonly path: string; readonly mimeType: string }>;
  readonly reasoningEffort?: string | undefined;
  readonly contextWindow?: string | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly sessionId?: string | undefined;
  readonly workspaceContext?: ProviderWorkspaceContext | undefined;
  readonly customInstructions?: string | undefined;
  readonly mcpUrl?: string | undefined;
  readonly mcpBearerTokenEnvVar?: string | undefined;
}): string[] {
  const selection = parseSparkyModelSelection(input.model);
  const args = [
    "--json-stream",
    "--provider",
    selection.provider,
    "--model",
    selection.model,
    "--cwd",
    input.cwd,
    "--prompt-stdin",
  ];
  if (selection.baseUrl) {
    args.push("--base-url", selection.baseUrl);
  }
  if (input.textOnly) {
    args.push("--text-only");
  }
  if (input.sessionId) {
    args.push("--session", input.sessionId);
  }
  if (input.workspaceContext === "none") {
    args.push("--no-workspace-context");
  }
  if (input.reasoningEffort?.trim()) {
    args.push("--effort", input.reasoningEffort.trim());
  }
  if (input.contextWindow?.trim()) {
    args.push("--context-window", input.contextWindow.trim());
  }
  if (input.interactionMode) {
    // The provider contract calls the normal coding mode "default", while
    // Sparky's CLI names that same mode "build".
    args.push("--interaction-mode", input.interactionMode === "plan" ? "plan" : "build");
  }
  for (const image of input.images ?? []) {
    args.push("--image-path", image.path, "--image-mime-type", image.mimeType);
  }
  if (input.customInstructions?.trim()) {
    args.push("--append-system-prompt", input.customInstructions.trim());
  }
  if (input.mcpUrl?.trim() && input.mcpBearerTokenEnvVar?.trim()) {
    args.push("--mcp-url", input.mcpUrl.trim());
    args.push("--mcp-bearer-token-env-var", input.mcpBearerTokenEnvVar.trim());
  }
  return args;
}

function runSparky(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly textOnly?: boolean | undefined;
  readonly images?: ReadonlyArray<{ readonly path: string; readonly mimeType: string }>;
  readonly reasoningEffort?: string | undefined;
  readonly contextWindow?: string | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly activeChildren?: Map<string, SparkyChildProcess> | undefined;
  readonly childKey?: string | undefined;
  readonly isCancelled?: (() => boolean) | undefined;
  readonly callbacks?: SparkyStreamCallbacks | undefined;
  readonly sessionId?: string | undefined;
  readonly workspaceContext?: ProviderWorkspaceContext | undefined;
  readonly customInstructions?: string | undefined;
  readonly mcpUrl?: string | undefined;
  readonly mcpBearerTokenEnvVar?: string | undefined;
}) {
  return Effect.tryPromise({
    try: () =>
      new Promise<SparkyProcessResult>((resolve, reject) => {
        const args = makeSparkyProcessArgs(input);

        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const child = NodeChildProcess.spawn(input.binaryPath, args, {
          cwd: input.cwd,
          env: input.environment,
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (input.childKey) input.activeChildren?.set(input.childKey, child);

        let stderr = "";
        const appendStderr = (chunk: string) => {
          const next = stderr + chunk;
          stderr = next.length > 65_536 ? next.slice(-65_536) : next;
        };
        const removeActiveChild = () => {
          if (input.childKey && input.activeChildren?.get(input.childKey) === child) {
            input.activeChildren.delete(input.childKey);
          }
        };
        const cleanup = () => {
          if (timeout !== undefined) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          removeActiveChild();
        };
        const resolveOnce = (value: SparkyProcessResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          // The JSON result is the protocol-level end of a one-shot turn. Do
          // not wait for a provider/MCP child to close its inherited event
          // loop before settling the desktop turn state.
          child.kill();
          resolve(value);
        };
        const rejectOnce = (cause: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          // A protocol/decode failure can happen while the child is still
          // writing. Do not leave that process alive after the turn has
          // already been converted into a terminal provider failure.
          child.kill();
          reject(cause);
        };
        const decoder = makeSparkyStreamDecoder({
          ...input.callbacks,
          onResult: () => {
            try {
              resolveOnce(decoder.finish());
            } catch (cause) {
              rejectOnce(cause);
            }
          },
        });
        const armTimeout = () => {
          if (settled) return;
          if (timeout !== undefined) clearTimeout(timeout);
          timeout = undefined;
          // The Rust tool runner owns each tool's configured timeout. It does
          // not stream tool stdout, so an open tool lifecycle is positive
          // activity even when the provider pipe is quiet for ten minutes.
          if (decoder.hasOpenTools()) return;
          timeout = setTimeout(() => {
            const message = `Sparky turn stalled after ${SPARKY_TURN_IDLE_TIMEOUT_MS}ms without provider activity.`;
            appendStderr(`\n${message}`);
            decoder.failOpenTools(message);
            // Reject immediately instead of waiting for the child close event.
            // This guarantees the orchestration layer receives the terminal
            // failure and can leave the UI's running state.
            child.kill("SIGKILL");
            rejectOnce(new Error(message));
          }, SPARKY_TURN_IDLE_TIMEOUT_MS);
        };
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          decoder.push(chunk);
          if (chunk.length > 0) armTimeout();
        });
        child.stderr.on("data", (chunk: string) => {
          appendStderr(chunk);
          if (chunk.length > 0) armTimeout();
        });
        child.stdin.on("error", (error) => {
          appendStderr(`\nUnable to send the prompt to Sparky: ${error.message}`);
        });
        child.stdin.end(input.prompt, "utf8");
        armTimeout();
        child.once("error", (err) => {
          if (settled) return;
          decoder.failOpenTools(`Sparky process error: ${err.message}`);
          rejectOnce(err);
        });
        child.once("close", (code) => {
          if (settled) return;
          cleanup();
          if (code !== 0) {
            decoder.failOpenTools(
              stderr.trim() ||
                `Sparky exited before returning a result (exit code ${code ?? "unknown"}).`,
            );
            rejectOnce(
              new Error(
                stderr.trim() ||
                  `Sparky exited before returning a result (exit code ${code ?? "unknown"}).`,
              ),
            );
            return;
          }
          try {
            resolveOnce(decoder.finish());
          } catch (cause) {
            rejectOnce(cause);
          }
        });
        if (input.isCancelled?.()) {
          decoder.failOpenTools("Sparky turn interrupted.");
          rejectOnce(new Error("Sparky turn interrupted."));
        }
      }),
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: "standalone",
        detail: formatSparkyProcessError(cause, input.workspaceContext),
        cause,
      }),
  });
}

export const makeSparkyAdapter = (options: SparkyAdapterOptions) =>
  Effect.gen(function* () {
    const adapterScope = yield* Scope.Scope;
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionState>();
    const activeChildren = new Map<string, SparkyChildProcess>();
    const activeFibers = new Map<string, Fiber.Fiber<void>>();
    const cancelledTurnKeys = new Set<string>();

    const stamp = (threadId: ThreadId, turnId?: TurnId) => ({
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId,
      createdAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
    });
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
    const logAdapterEvent = (
      threadId: ThreadId,
      event: string,
      data: Record<string, unknown> = {},
    ) =>
      options.nativeEventLogger
        ? options.nativeEventLogger.write(
            {
              schemaVersion: 1,
              source: "sparky",
              event,
              createdAt: new Date().toISOString(),
              ...data,
            },
            threadId,
          )
        : Effect.void;

    const missingSession = (threadId: ThreadId) =>
      Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId: String(threadId),
        }),
      );

    const executeTurn = (
      state: SessionState,
      turnId: TurnId,
      prompt: string,
      model: string,
      images: ReadonlyArray<{ readonly path: string; readonly mimeType: string }>,
      reasoningEffort: string | undefined,
      contextWindow: string | undefined,
      contextWindowTokens: number | undefined,
      interactionMode: ProviderInteractionMode,
    ) => {
      const threadId = state.session.threadId;
      const childKey = `${threadId}:${turnId}`;
      const cwd = state.runtimeCwd;
      const workspaceContext = state.session.workspaceContext ?? "project";
      const isTurnCancelled = () =>
        cancelledTurnKeys.has(childKey) ||
        sessions.get(threadId) !== state ||
        state.session.activeTurnId !== turnId;
      const toolPresentations = new Map<string, ReturnType<typeof sparkyToolPresentation>>();
      return Effect.gen(function* () {
        if (isTurnCancelled()) return;
        yield* publish({
          type: "turn.started",
          ...stamp(threadId, turnId),
          payload: { model },
        });
        const assistantSegments = makeSparkyAssistantSegmenter({
          onStarted: (segmentId) => {
            runEffectSync(
              publish({
                type: "item.started",
                ...stamp(threadId, turnId),
                itemId: RuntimeItemId.make(segmentId),
                payload: { itemType: "assistant_message", status: "inProgress" },
              }),
            );
          },
          onDelta: (segmentId, delta) => {
            runEffectSync(
              publish({
                type: "content.delta",
                ...stamp(threadId, turnId),
                itemId: RuntimeItemId.make(segmentId),
                payload: { streamKind: "assistant_text", delta },
              }),
            );
          },
          onCompleted: (segmentId, text) => {
            runEffectSync(
              publish({
                type: "item.completed",
                ...stamp(threadId, turnId),
                itemId: RuntimeItemId.make(segmentId),
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  detail: text,
                },
              }),
            );
          },
        });

        const customInstructions = options.getCustomInstructions
          ? yield* options.getCustomInstructions()
          : "";
        const mcpSession =
          workspaceContext === "none"
            ? undefined
            : McpProviderSession.readMcpProviderSession(threadId, options.instanceId);
        const activeMcp = mcpSession;
        const effectiveInstructions = [
          customInstructions.trim(),
          ...(mcpSession ? [SPARKY_BROWSER_INSTRUCTIONS] : []),
        ]
          .filter((instructions) => instructions.length > 0)
          .join("\n\n");
        let sessionId = resolveSparkySessionId(
          cwd,
          String(threadId),
          state.session.resumeCursor,
          workspaceContext,
        );
        const captureSessionIdentity = (nextSessionId: string) => {
          sessionId = nextSessionId;
          try {
            captureSparkySessionIdentity(state, cwd, threadId, nextSessionId);
          } catch (cause) {
            runEffectSync(
              Effect.logWarning("failed to persist early Sparky thread session binding", {
                threadId,
                sessionId: nextSessionId,
                cause,
              }),
            );
          }
        };
        const reconnectItemId = RuntimeItemId.make(`sparky-reconnect:${String(turnId)}`);
        let reconnectStarted = false;
        let successfulRetryCount = 0;
        let attemptProducedOutput = false;
        const reconnectData = (retryCount: number, error?: unknown) => ({
          provider: "sparky",
          retryCount,
          maxRetries: SPARKY_RECONNECT_RETRY_COUNT,
          ...(error
            ? {
                errorTag: errorTag(error),
                reason: sanitizeSparkyLogDetail(
                  error instanceof Error ? error.message : String(error),
                ),
              }
            : {}),
        });
        const publishReconnectStarted = (error: unknown) =>
          publish({
            type: "item.started",
            ...stamp(threadId, turnId),
            itemId: reconnectItemId,
            payload: {
              itemType: "dynamic_tool_call",
              status: "inProgress",
              title: `Reconnecting with ${SPARKY_RECONNECT_RETRY_COUNT} retries`,
              data: reconnectData(0, error),
            },
          });
        const publishReconnectUpdated = (retryCount: number, error: unknown) =>
          publish({
            type: "item.updated",
            ...stamp(threadId, turnId),
            itemId: reconnectItemId,
            payload: {
              itemType: "dynamic_tool_call",
              status: "inProgress",
              title: `Reconnecting (${retryCount}/${SPARKY_RECONNECT_RETRY_COUNT})`,
              data: reconnectData(retryCount, error),
            },
          });
        const publishReconnectCompleted = (success: boolean, retryCount: number, error?: unknown) =>
          publish({
            type: "item.completed",
            ...stamp(threadId, turnId),
            itemId: reconnectItemId,
            payload: {
              itemType: "dynamic_tool_call",
              status: success ? "completed" : "failed",
              title: success ? "Reconnected" : "Reconnect failed",
              data: reconnectData(retryCount, error),
            },
          });
        const runAttempt = (attempt: number) =>
          Effect.gen(function* () {
            if (isTurnCancelled()) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: String(threadId),
                detail: "Sparky turn interrupted.",
              });
            }
            attemptProducedOutput = false;
            yield* logAdapterEvent(threadId, "process.start", {
              attempt: attempt + 1,
              maxAttempts: SPARKY_RECONNECT_RETRY_COUNT + 1,
              model,
              ...(workspaceContext === "none" ? {} : { cwd }),
              workspaceContext,
              hasSession: sessionId !== undefined,
              hasMcpSession: activeMcp !== undefined,
            });
            const result = yield* runSparky({
              binaryPath: options.binaryPath,
              cwd,
              prompt,
              model,
              images,
              reasoningEffort,
              contextWindow,
              interactionMode,
              workspaceContext,
              environment: activeMcp
                ? {
                    ...options.environment,
                    [T3_MCP_BEARER_TOKEN_ENV_VAR]: activeMcp.authorizationHeader.replace(
                      /^Bearer\s+/u,
                      "",
                    ),
                  }
                : options.environment,
              activeChildren,
              childKey,
              sessionId,
              customInstructions: effectiveInstructions,
              isCancelled: isTurnCancelled,
              ...(activeMcp
                ? {
                    mcpUrl: activeMcp.endpoint,
                    mcpBearerTokenEnvVar: T3_MCP_BEARER_TOKEN_ENV_VAR,
                  }
                : {}),
              callbacks: {
                onDelta: (delta) => {
                  if (isTurnCancelled()) return;
                  attemptProducedOutput = true;
                  assistantSegments.pushDelta(delta);
                },
                onSessionId: captureSessionIdentity,
                onUsage: (usage) => {
                  if (isTurnCancelled()) return;
                  runEffectSync(
                    publish({
                      type: "thread.token-usage.updated",
                      ...stamp(threadId, turnId),
                      payload: {
                        usage: {
                          usedTokens: Math.max(0, Math.round(usage.totalTokens)),
                          totalProcessedTokens: Math.max(
                            0,
                            Math.round(usage.cumulativeTotalTokens),
                          ),
                          ...(contextWindowTokens !== undefined
                            ? { maxTokens: contextWindowTokens }
                            : {}),
                          inputTokens: Math.max(0, Math.round(usage.promptTokens)),
                          outputTokens: Math.max(0, Math.round(usage.completionTokens)),
                          lastUsedTokens: Math.max(0, Math.round(usage.totalTokens)),
                          lastInputTokens: Math.max(0, Math.round(usage.promptTokens)),
                          lastOutputTokens: Math.max(0, Math.round(usage.completionTokens)),
                          compactsAutomatically: true,
                        },
                      },
                    }),
                  );
                },
                onToolStarted: (event) => {
                  if (isTurnCancelled()) return;
                  if (isHiddenSparkyControlTool(event.toolName)) return;
                  attemptProducedOutput = true;
                  assistantSegments.closeBeforeTool();
                  const toolItemId = RuntimeItemId.make(event.toolCallId);
                  const presentation = sparkyToolPresentation(event.toolName, event.arguments);
                  toolPresentations.set(event.toolCallId, presentation);
                  const data = { ...presentation.data, toolCallId: event.toolCallId };
                  runEffectSync(
                    publish({
                      type: "item.started",
                      ...stamp(threadId, turnId),
                      itemId: toolItemId,
                      payload: {
                        itemType: presentation.itemType,
                        status: "inProgress",
                        title: presentation.title,
                        data,
                      },
                    }),
                  );
                },
                onToolCompleted: (event) => {
                  if (isHiddenSparkyControlTool(event.toolName)) return;
                  const toolItemId = RuntimeItemId.make(event.toolCallId);
                  const presentation =
                    toolPresentations.get(event.toolCallId) ??
                    sparkyToolPresentation(event.toolName, {});
                  toolPresentations.delete(event.toolCallId);
                  runEffectSync(
                    publish({
                      type: "item.completed",
                      ...stamp(threadId, turnId),
                      itemId: toolItemId,
                      payload: {
                        itemType: presentation.itemType,
                        status: event.isError ? "failed" : "completed",
                        title: presentation.title,
                        // Keep the full output in the structured result only. The
                        // previous event duplicated large tool payloads in both
                        // detail and data, increasing ingestion and UI costs.
                        data: {
                          ...presentation.data,
                          toolCallId: event.toolCallId,
                          result: { output: event.output, isError: event.isError },
                        },
                      },
                    }),
                  );
                },
              },
            });
            if (result.sessionId) {
              captureSessionIdentity(result.sessionId);
            }
            yield* logAdapterEvent(threadId, "process.succeeded", {
              attempt: attempt + 1,
              responseChars: result.response.length,
              sessionIdPresent: result.sessionId !== undefined,
            });
            successfulRetryCount = attempt;
            return result;
          });
        const runWithReconnect = (
          retryIndex: number,
        ): Effect.Effect<SparkyProcessResult, ProviderAdapterProcessError> =>
          runAttempt(retryIndex).pipe(
            Effect.catch((error) => {
              // Replaying a prompt after visible text or a tool call was
              // emitted can duplicate work. Only reconnect automatically when
              // the failed process produced no provider output yet.
              const retryable = !attemptProducedOutput && isRetryableSparkyProcessError(error);
              const detail = isSparkyProcessError(error) ? error.detail : String(error);
              return Effect.gen(function* () {
                if (isTurnCancelled()) return yield* error;
                yield* logAdapterEvent(threadId, "process.failed", {
                  attempt: retryIndex + 1,
                  retryable,
                  errorTag: errorTag(error),
                  detail: sanitizeSparkyLogDetail(detail),
                });
                if (!retryable || retryIndex >= SPARKY_RECONNECT_RETRY_COUNT) {
                  if (reconnectStarted) {
                    yield* logAdapterEvent(threadId, "reconnect.exhausted", {
                      retryCount: retryIndex,
                      errorTag: errorTag(error),
                    });
                    yield* publishReconnectCompleted(false, retryIndex, error);
                  }
                  return yield* error;
                }
                if (!reconnectStarted) {
                  reconnectStarted = true;
                  yield* logAdapterEvent(threadId, "reconnect.started", {
                    maxRetries: SPARKY_RECONNECT_RETRY_COUNT,
                    errorTag: errorTag(error),
                  });
                  yield* publishReconnectStarted(error);
                }
                const nextRetry = retryIndex + 1;
                yield* logAdapterEvent(threadId, "reconnect.attempt", {
                  retryCount: nextRetry,
                  maxRetries: SPARKY_RECONNECT_RETRY_COUNT,
                });
                yield* publishReconnectUpdated(nextRetry, error);
                yield* Effect.sleep(
                  Duration.millis(SPARKY_RECONNECT_BACKOFF_MS[retryIndex] ?? 16_000),
                );
                return yield* runWithReconnect(nextRetry);
              });
            }),
          );
        const result = yield* runWithReconnect(0);
        // `interruptTurn` owns the terminal interrupted event. If the child
        // also reports a process failure while it is being killed, do not
        // publish a second failed completion for the already-settled turn.
        if (isTurnCancelled()) return;
        if (reconnectStarted) {
          yield* logAdapterEvent(threadId, "reconnect.succeeded", {
            retryCount: successfulRetryCount,
          });
          yield* publishReconnectCompleted(true, successfulRetryCount);
        }
        assistantSegments.finish(result.response);

        state.snapshot = {
          threadId,
          turns: [
            ...state.snapshot.turns,
            {
              id: turnId,
              items: [
                { type: "userMessage", content: [{ type: "text", text: prompt }] },
                { type: "agentMessage", text: result.response },
              ],
            },
          ],
        };
        state.session = {
          ...state.session,
          status: "ready",
          activeTurnId: undefined,
          lastError: undefined,
          updatedAt: new Date().toISOString(),
          resumeCursor: result.sessionId
            ? {
                threadId: String(threadId),
                sparkySessionId: result.sessionId,
                ...(workspaceContext === "none" ? {} : { cwd }),
              }
            : state.session.resumeCursor,
        };

        yield* publish({
          type: "turn.completed",
          ...stamp(threadId, turnId),
          payload: {
            state: "completed",
            ...(result.sessionId
              ? {
                  resumeCursor: {
                    threadId: String(threadId),
                    sparkySessionId: result.sessionId,
                    ...(workspaceContext === "none" ? {} : { cwd }),
                  },
                }
              : {}),
          },
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (isTurnCancelled()) return;
            const errorMessage = error?.message ?? "";
            const isContextLengthError =
              errorMessage.includes("context_length_exceeded") ||
              errorMessage.includes("context length") ||
              errorMessage.includes("Context window") ||
              errorMessage.includes("context window");

            // The Rust runtime performs one bounded same-session compaction
            // and retry for context overflow. Preserve the cursor here so a
            // failed recovery can never silently turn the next message into a
            // brand-new conversation.
            if (isContextLengthError) {
              yield* Effect.logWarning(
                "context window recovery failed; preserving session cursor",
                {
                  threadId,
                  turnId,
                },
              );
            }

            state.session = {
              ...state.session,
              status: "error",
              activeTurnId: undefined,
              lastError: errorMessage || "Sparky turn failed.",
              updatedAt: new Date().toISOString(),
            };

            yield* publish({
              type: "runtime.error",
              ...stamp(threadId, turnId),
              payload: { message: errorMessage, class: "provider_error" },
            });
            yield* publish({
              type: "turn.completed",
              ...stamp(threadId, turnId),
              payload: {
                state: "failed",
                errorMessage: isContextLengthError
                  ? "Conversation context is full and automatic compaction could not complete. The existing conversation was preserved; retry this message after checking the provider connection."
                  : errorMessage,
              },
            });
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            activeChildren.delete(childKey);
            activeFibers.delete(childKey);
            cancelledTurnKeys.delete(childKey);
          }),
        ),
      );
    };

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession: (input) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          const threadId = String(input.threadId);
          const requestedSessionId = sparkySessionIdFromResumeCursor(input.resumeCursor, threadId);
          const workspaceContext: ProviderWorkspaceContext = input.workspaceContext ?? "project";
          const runtimeCwd =
            workspaceContext === "none"
              ? projectFreeRuntimeCwd(options.attachmentsDir, threadId)
              : (input.cwd ?? cwdFromResumeCursor(input.resumeCursor, threadId));
          if (runtimeCwd === undefined) {
            throw new Error(
              `Cannot start Sparky conversation '${threadId}': a project workspace CWD is required.`,
            );
          }
          const sparkySessionId =
            sessionIdFromResumeCursor(runtimeCwd, threadId, input.resumeCursor) ??
            readSparkySessionBinding(runtimeCwd, threadId);
          if (requestedSessionId && !sparkySessionId) {
            throw new Error(
              workspaceContext === "none"
                ? `Cannot resume Sparky conversation '${threadId}': the persisted session is not available. Refusing to start a new conversation.`
                : `Cannot resume Sparky conversation '${threadId}': session '${requestedSessionId}' is not available in '${runtimeCwd}'. Refusing to start a new conversation.`,
            );
          }
          const resumeCursorWithoutProjectCwd =
            workspaceContext === "none" && cwdFromResumeCursor(input.resumeCursor, threadId)
              ? undefined
              : input.resumeCursor;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            workspaceContext,
            threadId: input.threadId,
            ...(workspaceContext === "none" ? {} : { cwd: runtimeCwd }),
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            ...(input.modelSelection?.contextWindowSource !== "models.dev" ||
            isCodexOAuthModel(input.modelSelection?.model)
              ? (() => {
                  const selectedContext = input.modelSelection
                    ? normalizeSparkyContextWindow(
                        input.modelSelection.model,
                        getModelSelectionStringOptionValue(input.modelSelection, "contextWindow"),
                      )
                    : undefined;
                  const selectedContextTokens = parseSparkyContextWindowTokens(selectedContext);
                  return selectedContext !== undefined
                    ? {
                        contextWindowTokens: selectedContextTokens,
                        contextWindowSource: isCodexOAuthModel(input.modelSelection?.model)
                          ? ("oauth" as const)
                          : ("provider" as const),
                      }
                    : {};
                })()
              : {}),
            ...(sparkySessionId
              ? {
                  resumeCursor: {
                    threadId,
                    sparkySessionId,
                    ...(workspaceContext === "none" ? {} : { cwd: runtimeCwd }),
                  },
                }
              : resumeCursorWithoutProjectCwd !== undefined
                ? { resumeCursor: resumeCursorWithoutProjectCwd }
                : {}),
            createdAt: now,
            updatedAt: now,
          };
          sessions.set(input.threadId, {
            session,
            runtimeCwd,
            snapshot: { threadId: input.threadId, turns: [] },
            nextTurn: 0,
          });
          return session;
        }),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const state = sessions.get(input.threadId);
          if (!state) return yield* missingSession(input.threadId);
          const prompt = input.input?.trim();
          if (!prompt) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Sparky requires a text prompt.",
            });
          }
          const images = yield* Effect.forEach(
            input.attachments ?? [],
            (attachment: ChatAttachment) =>
              Effect.gen(function* () {
                const path = resolveAttachmentPath({
                  attachmentsDir: options.attachmentsDir,
                  attachment,
                });
                if (!path || !NodeFS.existsSync(path)) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "thread.turn.start",
                    detail: `Attachment '${attachment.name}' could not be loaded by Sparky.`,
                  });
                }
                return { path, mimeType: attachment.mimeType };
              }),
          );
          const model = input.modelSelection?.model ?? state.session.model ?? "GPT-5.6 Sol";
          const reasoningEffort = input.modelSelection
            ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
            : undefined;
          const contextWindow = resolveSparkyRuntimeContextWindow(
            model,
            input.modelSelection,
            options.environment,
          );
          const contextWindowTokens = parseSparkyContextWindowTokens(contextWindow);
          const effectiveContextWindowTokens = normalizeCodexOAuthEffectiveContextWindowTokens(
            model,
            contextWindowTokens,
            options.environment,
          );
          const interactionMode = input.interactionMode ?? "default";
          state.nextTurn += 1;
          const turnId = TurnId.make(`sparky-${state.nextTurn}-${NodeCrypto.randomUUID()}`);
          const modelChanged = state.session.model !== undefined && state.session.model !== model;
          if (modelChanged && contextWindowTokens === undefined) {
            const {
              contextWindowTokens: _previousContextWindowTokens,
              contextWindowSource: _previousContextWindowSource,
              ...sessionWithoutContextWindow
            } = state.session;
            state.session = {
              ...sessionWithoutContextWindow,
              status: "running",
              activeTurnId: turnId,
              model,
              updatedAt: new Date().toISOString(),
            };
          } else {
            state.session = {
              ...state.session,
              status: "running",
              activeTurnId: turnId,
              model,
              ...(effectiveContextWindowTokens !== undefined
                ? {
                    contextWindowTokens: effectiveContextWindowTokens,
                    contextWindowSource: isCodexOAuthModel(model)
                      ? ("oauth" as const)
                      : ("provider" as const),
                  }
                : {}),
              updatedAt: new Date().toISOString(),
            };
          }
          const fiber = yield* executeTurn(
            state,
            turnId,
            prompt,
            model,
            images,
            reasoningEffort,
            contextWindow,
            effectiveContextWindowTokens,
            interactionMode,
          ).pipe(Effect.forkIn(adapterScope));
          activeFibers.set(`${input.threadId}:${turnId}`, fiber);
          return { threadId: input.threadId, turnId };
        }),
      interruptTurn: (threadId, turnId) => {
        const state = sessions.get(threadId);
        if (!state) return missingSession(threadId);
        const targetTurnId = turnId ?? state.session.activeTurnId;
        if (!targetTurnId) return Effect.void;
        const key = `${threadId}:${targetTurnId}`;
        return Effect.gen(function* () {
          cancelledTurnKeys.add(key);
          activeChildren.get(key)?.kill();
          const fiber = activeFibers.get(key);
          if (fiber) yield* Fiber.interrupt(fiber);
          const currentState = sessions.get(threadId);
          if (currentState?.session.activeTurnId === targetTurnId) {
            currentState.session = {
              ...currentState.session,
              status: "ready",
              activeTurnId: undefined,
              lastError: undefined,
              updatedAt: new Date().toISOString(),
            };
          }
          if (!fiber) cancelledTurnKeys.delete(key);
          yield* publish({
            type: "turn.completed",
            ...stamp(threadId, targetTurnId),
            payload: { state: "interrupted" },
          });
        });
      },
      respondToRequest: (threadId) =>
        sessions.has(threadId)
          ? Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "respondToRequest",
                issue: "Sparky handles tool execution inside its own runtime.",
              }),
            )
          : missingSession(threadId),
      respondToUserInput: (threadId) =>
        sessions.has(threadId)
          ? Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "respondToUserInput",
                issue: "Sparky does not expose structured follow-up requests.",
              }),
            )
          : missingSession(threadId),
      stopSession: (threadId) =>
        Effect.gen(function* () {
          const activeKeys = [
            ...new Set(
              [...activeFibers.keys(), ...activeChildren.keys()].filter((key) =>
                key.startsWith(`${threadId}:`),
              ),
            ),
          ];
          for (const key of activeKeys) cancelledTurnKeys.add(key);
          for (const [key, child] of activeChildren) {
            if (key.startsWith(`${threadId}:`)) child.kill();
          }
          for (const key of activeKeys) {
            const fiber = activeFibers.get(key);
            if (fiber) yield* Fiber.interrupt(fiber);
          }
          sessions.delete(threadId);
        }),
      listSessions: () => Effect.sync(() => [...sessions.values()].map((state) => state.session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) => {
        const state = sessions.get(threadId);
        return state ? Effect.succeed(state.snapshot) : missingSession(threadId);
      },
      rollbackThread: (threadId, numTurns) => {
        const state = sessions.get(threadId);
        if (!state) return missingSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > state.snapshot.turns.length) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be within the current Sparky transcript.",
            }),
          );
        }
        return Effect.sync(() => {
          state.snapshot = {
            threadId,
            turns: state.snapshot.turns.slice(0, state.snapshot.turns.length - numTurns),
          };
          state.nextTurn = state.snapshot.turns.length;
          return state.snapshot;
        });
      },
      stopAll: () =>
        Effect.sync(() => {
          for (const child of activeChildren.values()) child.kill();
          activeChildren.clear();
          sessions.clear();
        }),
      subscribeEvents: PubSub.subscribe(runtimeEvents),
      streamEvents: Stream.fromPubSub(runtimeEvents),
    };

    return adapter;
  });

export const runSparkyTextGeneration = (input: Parameters<typeof runSparky>[0]) =>
  runSparky({ ...input, textOnly: true });
