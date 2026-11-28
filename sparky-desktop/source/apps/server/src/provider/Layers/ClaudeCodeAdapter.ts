// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RequestOpenedPayload,
  type ThreadId,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  asClaudeJson,
  claudeResultError,
  loadClaudeInput,
  runClaudeProcess,
  type ClaudeExecutable,
  type ClaudeJson,
} from "./claudeCodeProcess.ts";

export const CLAUDE_CODE_DRIVER = ProviderDriverKind.make("claudeAgent");
export const CLAUDE_CODE_DEFAULT_MODEL = "sonnet";

interface ClaudeCursor {
  readonly claudeSessionId: string;
  readonly threadId: ThreadId;
  readonly cwd: string;
}

export function readClaudeCursor(value: unknown, threadId: ThreadId, cwd: string): ClaudeCursor {
  const cursor = asClaudeJson(value);
  if (cursor?.threadId !== threadId || cursor.cwd !== cwd ||
    typeof cursor.claudeSessionId !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(cursor.claudeSessionId)) {
    throw new Error("Claude Code cannot resume this conversation in its current workspace. Start a new thread to use another workspace.");
  }
  return { claudeSessionId: cursor.claudeSessionId, threadId, cwd };
}

export function claudeSessionArgs(cursor: ClaudeCursor, resume: boolean): ReadonlyArray<string> {
  return [resume ? "--resume" : "--session-id", cursor.claudeSessionId];
}

const NO_MCP_ARGS = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
export const CLAUDE_NO_WORKSPACE_ARGS = ["--setting-sources", "user", "--tools", "", ...NO_MCP_ARGS];

type RequestType = RequestOpenedPayload["requestType"];
interface Approval {
  readonly requestType: RequestType;
  readonly respond: (allow: boolean) => void;
}
interface ActiveTurn {
  readonly id: TurnId;
  readonly controller: AbortController;
  readonly approvals: Map<string, Approval>;
}
interface SessionState {
  session: ProviderSession;
  readonly cwd: string;
  cursor: ClaudeCursor | undefined;
  active: ActiveTurn | undefined;
}

function requestError(method: string, detail: string) {
  return new ProviderAdapterRequestError({ provider: CLAUDE_CODE_DRIVER, method, detail });
}

export const makeClaudeCodeAdapter = (options: ClaudeExecutable & {
  readonly instanceId: ProviderInstanceId;
  readonly attachmentsDir: string;
  readonly privateWorkspaceDir: string;
  readonly launchArgs?: ReadonlyArray<string>;
}) => Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, SessionState>();
  const stamp = (threadId: ThreadId, turnId: TurnId) => ({
    eventId: EventId.make(randomUUID()),
    provider: CLAUDE_CODE_DRIVER,
    providerInstanceId: options.instanceId,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });
  const publish = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const missing = (threadId: ThreadId) => new ProviderAdapterSessionNotFoundError({
    provider: CLAUDE_CODE_DRIVER, threadId,
  });
  const finishTurn = (state: SessionState, active: ActiveTurn, status: "completed" | "failed" | "interrupted", errorMessage?: string) =>
    Effect.gen(function* () {
      if (state.active !== active) return;
      state.active = undefined;
      state.session = {
        ...state.session,
        activeTurnId: undefined,
        status: status === "failed" ? "error" : "ready",
        lastError: errorMessage,
        updatedAt: new Date().toISOString(),
      };
      for (const [id, approval] of active.approvals) {
        yield* publish({
          ...stamp(state.session.threadId, active.id),
          type: "request.resolved",
          requestId: RuntimeRequestId.make(id),
          payload: { requestType: approval.requestType, decision: "cancel" },
        });
      }
      active.approvals.clear();
      if (errorMessage) {
        yield* publish({
          ...stamp(state.session.threadId, active.id),
          type: "runtime.error",
          payload: { message: errorMessage, class: "provider_error" },
        });
      }
      yield* publish({
        ...stamp(state.session.threadId, active.id),
        type: "turn.completed",
        payload: { state: status, ...(errorMessage ? { errorMessage } : {}), resumeCursor: state.cursor },
      });
    });
  const interrupt = (state: SessionState, active: ActiveTurn) => Effect.gen(function* () {
    active.controller.abort();
    yield* finishTurn(state, active, "interrupted");
  });
  const stopAll = () => Effect.gen(function* () {
    for (const state of sessions.values()) {
      if (state.active) yield* interrupt(state, state.active);
    }
    sessions.clear();
  });
  yield* Effect.addFinalizer(stopAll);

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: CLAUDE_CODE_DRIVER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input) => Effect.tryPromise({
      try: async () => {
        if (sessions.get(input.threadId)?.active) throw new Error("The Claude Code thread already has an active turn.");
        const workspaceContext = input.workspaceContext ?? "project";
        const rawCwd = workspaceContext === "none"
          ? resolve(options.privateWorkspaceDir, createHash("sha256").update(input.threadId).digest("hex"))
          : input.cwd;
        if (!rawCwd) throw new Error("Claude Code requires a project workspace path.");
        const cwd = resolve(rawCwd);
        const cursor = input.resumeCursor == null
          ? sessions.get(input.threadId)?.cursor
          : readClaudeCursor(input.resumeCursor, input.threadId, cwd);
        if (cursor && cursor.cwd !== cwd) throw new Error("Claude Code cannot resume in another workspace.");
        if (workspaceContext === "none") await mkdir(cwd, { recursive: true });
        const now = new Date().toISOString();
        const session: ProviderSession = {
          provider: CLAUDE_CODE_DRIVER,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          workspaceContext,
          ...(workspaceContext === "project" ? { cwd } : {}),
          model: input.modelSelection?.model ?? CLAUDE_CODE_DEFAULT_MODEL,
          threadId: input.threadId,
          ...(cursor ? { resumeCursor: cursor } : {}),
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(input.threadId, { session, cwd, cursor, active: undefined });
        return session;
      },
      catch: (error) => requestError("startSession", String(error)),
    }),
    sendTurn: (input) => Effect.gen(function* () {
      const state = sessions.get(input.threadId);
      if (!state) return yield* missing(input.threadId);
      if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
        return yield* requestError("sendTurn", "This thread is locked to its original Claude Code instance.");
      }
      if (state.active) return yield* requestError("sendTurn", "Claude Code is already working on this turn.");
      const content = yield* Effect.tryPromise({
        try: () => loadClaudeInput(input.input ?? "", input.attachments ?? [], options.attachmentsDir),
        catch: (error) => requestError("sendTurn", String(error)),
      });
      if (content.length === 0) return yield* requestError("sendTurn", "Send a prompt or an image.");
      if (sessions.get(input.threadId) !== state || state.active) {
        return yield* requestError("sendTurn", "The Claude Code session changed while preparing the prompt.");
      }
      const model = input.modelSelection?.model ?? state.session.model ?? CLAUDE_CODE_DEFAULT_MODEL;
      const resume = state.cursor !== undefined;
      const cursor = state.cursor ?? { claudeSessionId: randomUUID(), threadId: input.threadId, cwd: state.cwd };
      const active: ActiveTurn = { id: TurnId.make(randomUUID()), controller: new AbortController(), approvals: new Map() };
      state.active = active;
      state.cursor = cursor;
      state.session = {
        ...state.session,
        model,
        status: "running",
        activeTurnId: active.id,
        resumeCursor: cursor,
        updatedAt: new Date().toISOString(),
      };
      const { threadId } = input;
      const emit = (event: ProviderRuntimeEvent) => Effect.runSync(publish(event));
      const base = () => stamp(threadId, active.id);
      const itemId = RuntimeItemId.make(`claude-assistant-${active.id}`);
      let text = "";
      const delta = (value: string) => {
        if (!value || state.active !== active) return;
        if (!text) emit({ ...base(), type: "item.started", itemId, payload: { itemType: "assistant_message", status: "inProgress" } });
        text += value;
        emit({ ...base(), type: "content.delta", itemId, payload: { streamKind: "assistant_text", delta: value } });
      };
      const toolItems = new Map<string, string>();
      // Accumulate partial text per Claude API message. Its finalized assistant
      // frame repeats those deltas, but sometimes contains text not streamed.
      let streamed = "";
      const onFrame = (frame: ClaudeJson, write: (value: ClaudeJson) => void) => {
        if (state.active !== active || frame.parent_tool_use_id) return;
        if (frame.type === "stream_event") {
          const event = asClaudeJson(frame.event);
          if (event?.type === "message_start") streamed = "";
          const block = asClaudeJson(event?.delta);
          if (event?.type === "content_block_delta" && block?.type === "text_delta" && typeof block.text === "string") {
            streamed += block.text;
            delta(block.text);
          }
        } else if (frame.type === "assistant") {
          const message = asClaudeJson(frame.message);
          if (!Array.isArray(message?.content)) return;
          let messageText = "";
          for (const value of message.content) {
            const block = asClaudeJson(value);
            if (block?.type === "text" && typeof block.text === "string") messageText += block.text;
            if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
            toolItems.set(block.id, block.name);
            emit({ ...base(), type: "item.started", itemId: RuntimeItemId.make(block.id), payload: { itemType: "dynamic_tool_call", status: "inProgress", title: block.name } });
          }
          if (messageText.startsWith(streamed)) delta(messageText.slice(streamed.length));
          streamed = "";
        } else if (frame.type === "user") {
          const content = asClaudeJson(frame.message)?.content;
          if (!Array.isArray(content)) return;
          for (const value of content) {
            const block = asClaudeJson(value);
            if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
            const title = toolItems.get(block.tool_use_id);
            if (!title) continue;
            toolItems.delete(block.tool_use_id);
            emit({ ...base(), type: "item.completed", itemId: RuntimeItemId.make(block.tool_use_id), payload: { itemType: "dynamic_tool_call", status: block.is_error ? "failed" : "completed", title } });
          }
        } else if (frame.type === "control_cancel_request" && typeof frame.request_id === "string") {
          const approval = active.approvals.get(frame.request_id);
          if (!approval) return;
          active.approvals.delete(frame.request_id);
          emit({ ...base(), type: "request.resolved", requestId: RuntimeRequestId.make(frame.request_id), payload: { requestType: approval.requestType, decision: "cancel" } });
        } else if (frame.type === "control_request" && typeof frame.request_id === "string") {
          const id = frame.request_id;
          const request = asClaudeJson(frame.request);
          const tool = request?.tool_name;
          const args = asClaudeJson(request?.input) ?? {};
          const respond = (allow: boolean, message = "Tool use declined in Sparky.") => write({
            type: "control_response",
            response: {
              subtype: "success", request_id: id,
              response: {
                ...(allow ? { behavior: "allow", updatedInput: args } : { behavior: "deny", message }),
                ...(typeof request?.tool_use_id === "string" ? { toolUseID: request.tool_use_id } : {}),
              },
            },
          });
          if (request?.subtype !== "can_use_tool" || typeof tool !== "string" || !tool.trim()) {
            write({ type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported Claude Code control request." } });
            return;
          }
          if (tool === "AskUserQuestion") {
            respond(false, "Ask the user directly in the Claude Code chat instead.");
            return;
          }
          if (tool === "ExitPlanMode" && input.interactionMode === "plan") {
            respond(false, "Present your plan in chat. Do not leave plan mode this turn.");
            return;
          }
          const requestType: RequestType = tool === "Bash" ? "command_execution_approval"
            : tool === "Edit" || tool === "Write" || tool === "NotebookEdit" ? "file_change_approval"
            : "dynamic_tool_call";
          const detail = typeof args.command === "string" && args.command.trim() ? args.command
            : typeof args.file_path === "string" ? `${tool}: ${args.file_path}` : `Allow Claude Code to use ${tool}?`;
          active.approvals.set(id, { requestType, respond });
          emit({ ...base(), type: "request.opened", requestId: RuntimeRequestId.make(id), payload: { requestType, detail } });
        }
      };
      const play = Effect.gen(function* () {
        yield* publish({ ...base(), type: "turn.started", payload: { model } });
        const result = yield* Effect.tryPromise({
          try: () => runClaudeProcess({
            ...options,
            cwd: state.cwd,
            signal: active.controller.signal,
            content,
            sessionId: cursor.claudeSessionId,
            onFrame,
            args: [
              ...(options.launchArgs ?? []),
              "--model", model,
              ...claudeSessionArgs(cursor, resume),
              "--include-partial-messages", "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
              "--permission-mode", input.interactionMode === "plan" ? "plan"
                : state.session.runtimeMode === "full-access" ? "bypassPermissions"
                : state.session.runtimeMode === "auto-accept-edits" ? "acceptEdits" : "default",
              ...(state.session.workspaceContext === "none" ? CLAUDE_NO_WORKSPACE_ARGS : []),
            ],
          }),
          catch: (error) => error instanceof Error ? error.message : String(error),
        }).pipe(Effect.result);
        if (state.active !== active) return;
        const frame = result._tag === "Success" ? result.success : undefined;
        const error = result._tag === "Failure" ? result.failure
          : frame?.session_id !== cursor.claudeSessionId && !claudeResultError(result.success)
            ? "Claude Code returned a different session ID; the conversation was not rebound."
            : claudeResultError(result.success);
        if (!error && !text && typeof frame?.result === "string") delta(frame.result);
        if (text) yield* publish({ ...base(), type: "item.completed", itemId, payload: { itemType: "assistant_message", status: "completed", ...(text.trim() ? { detail: text } : {}) } });
        for (const [id, title] of toolItems) {
          yield* publish({ ...base(), type: "item.completed", itemId: RuntimeItemId.make(id), payload: { itemType: "dynamic_tool_call", status: error ? "failed" : "completed", title } });
        }
        yield* finishTurn(state, active, error ? "failed" : "completed", error);
      });
      yield* play.pipe(Effect.forkIn(scope));
      return { threadId, turnId: active.id, resumeCursor: cursor };
    }),
    interruptTurn: (threadId, turnId) => Effect.gen(function* () {
      const state = sessions.get(threadId);
      if (state?.active && (!turnId || state.active.id === turnId)) yield* interrupt(state, state.active);
    }),
    respondToRequest: (threadId, requestId, decision) => Effect.gen(function* () {
      const active = sessions.get(threadId)?.active;
      const approval = active?.approvals.get(requestId);
      if (!active || !approval) return yield* requestError("respondToRequest", "This tool request is no longer active.");
      active.approvals.delete(requestId);
      approval.respond(decision === "accept" || decision === "acceptForSession");
      yield* publish({ ...stamp(threadId, active.id), type: "request.resolved", requestId: RuntimeRequestId.make(requestId), payload: { requestType: approval.requestType, decision } });
    }),
    respondToUserInput: () => Effect.fail(requestError("respondToUserInput", "Reply to Claude Code in chat.")),
    stopSession: (threadId) => Effect.gen(function* () {
      const state = sessions.get(threadId);
      if (state?.active) yield* interrupt(state, state.active);
      sessions.delete(threadId);
    }),
    stopAll,
    listSessions: () => Effect.sync(() => Array.from(sessions.values(), ({ session }) => session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) => Effect.fail(requestError("readThread", `Claude Code transcript inspection is not supported for '${threadId}'.`)),
    rollbackThread: () => Effect.fail(requestError("rollbackThread", "Claude Code does not support turn rollback in Sparky.")),
    streamEvents: Stream.fromPubSub(events),
    subscribeEvents: PubSub.subscribe(events),
  };
  return adapter;
});
