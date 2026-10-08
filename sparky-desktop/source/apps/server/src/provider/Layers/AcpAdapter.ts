// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off runEffectInsideEffect:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@sparky/contracts";
import { resolveSpawnCommand } from "@sparky/shared/shell";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { AcpConnection, record } from "../acpConnection.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { currentAuthSessionId } from "../ProviderExecutionContext.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";

interface Options {
  instanceId: ProviderInstanceId;
  driver: ProviderDriverKind;
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  stateDir: string;
  attachmentsDir: string;
}
interface Permission {
  resolve: (outcome: unknown) => void;
  options: Record<string, unknown>[];
  requestType: "file_change_approval" | "command_execution_approval";
}
interface State {
  connection: AcpConnection;
  session: ProviderSession;
  sessionId: string;
  cwd: string;
  imageSupported: boolean;
  modes: Set<string>;
  defaultMode: string | undefined;
  permissions: Map<string, Permission>;
  snapshot: ProviderThreadSnapshot;
  active: { turnId: TurnId; itemId: RuntimeItemId; text: string; started: boolean } | undefined;
  tools: Map<
    string,
    {
      itemType: "command_execution" | "file_change" | "dynamic_tool_call";
      title: string;
      data: Record<string, unknown>;
    }
  >;
}

export const makeAcpAdapter = (options: Options) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const states = new Map<ThreadId, State>();
    const connections = new Set<AcpConnection>();
    const stamp = (threadId: ThreadId, turnId?: TurnId) => ({
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: options.driver,
      providerInstanceId: options.instanceId,
      threadId,
      createdAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
    });
    const emit = (event: ProviderRuntimeEvent) => {
      Effect.runSync(PubSub.publish(events, event));
    };
    const failure = (method: string, cause: unknown) =>
      new ProviderAdapterRequestError({
        provider: options.driver,
        method,
        detail: cause instanceof Error ? cause.message : "ACP request failed",
        cause,
      });
    const missing = (threadId: ThreadId) =>
      Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: options.driver,
          threadId,
        }),
      );
    const invalid = (operation: string, issue: string) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: options.driver,
          operation,
          issue,
        }),
      );
    const cancelPermissions = (state: State) => {
      for (const permission of state.permissions.values())
        permission.resolve({ outcome: { outcome: "cancelled" } });
      state.permissions.clear();
    };
    const finish = (
      state: State,
      status: "completed" | "failed" | "interrupted",
      errorMessage?: string,
    ) => {
      const active = state.active;
      if (!active) return;
      state.active = undefined;
      cancelPermissions(state);
      if (active.started)
        emit({
          type: "item.completed",
          ...stamp(state.session.threadId, active.turnId),
          itemId: active.itemId,
          payload: {
            itemType: "assistant_message",
            status: status === "failed" ? "failed" : "completed",
            data: { text: active.text },
          },
        });
      state.snapshot = {
        ...state.snapshot,
        turns: [...state.snapshot.turns, { id: active.turnId, items: [{ text: active.text }] }],
      };
      state.session = {
        ...state.session,
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage,
        updatedAt: new Date().toISOString(),
      };
      emit({
        type: "turn.completed",
        ...stamp(state.session.threadId, active.turnId),
        payload: {
          state: status,
          resumeCursor: state.session.resumeCursor,
          ...(errorMessage ? { errorMessage } : {}),
        },
      });
    };
    const update = (state: State, params: Record<string, unknown>) => {
      // loadSession replays history. Ignore it: the orchestration transcript is already persisted.
      if (params.sessionId !== state.sessionId || !state.active) return;
      const active = state.active;
      const value = record(params.update);
      const base = stamp(state.session.threadId, active.turnId);
      if (
        value.sessionUpdate === "agent_message_chunk" ||
        value.sessionUpdate === "agent_thought_chunk"
      ) {
        const content = record(value.content);
        if (content.type !== "text" || typeof content.text !== "string") return;
        const reasoning = value.sessionUpdate === "agent_thought_chunk";
        const itemId = reasoning ? RuntimeItemId.make(`${active.itemId}-reasoning`) : active.itemId;
        if (!reasoning && !active.started) {
          active.started = true;
          emit({
            type: "item.started",
            ...base,
            itemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
        }
        if (!reasoning) active.text += content.text;
        emit({
          type: "content.delta",
          ...base,
          itemId,
          payload: {
            streamKind: reasoning ? "reasoning_text" : "assistant_text",
            delta: content.text,
          },
        });
      } else if (
        value.sessionUpdate === "tool_call" ||
        value.sessionUpdate === "tool_call_update"
      ) {
        if (typeof value.toolCallId !== "string") return;
        const previous = state.tools.get(value.toolCallId);
        const tool = {
          itemType:
            previous?.itemType ??
            (value.kind === "execute"
              ? "command_execution"
              : value.kind === "edit"
                ? "file_change"
                : "dynamic_tool_call"),
          title:
            typeof value.title === "string" && value.title
              ? value.title
              : (previous?.title ?? "Harness tool"),
          data: { ...previous?.data, ...value },
        } as NonNullable<typeof previous>;
        state.tools.set(value.toolCallId, tool);
        const done = value.status === "completed" || value.status === "failed";
        emit({
          type: done ? "item.completed" : previous ? "item.updated" : "item.started",
          ...base,
          itemId: RuntimeItemId.make(`${active.turnId}-${value.toolCallId}`),
          payload: {
            itemType: tool.itemType,
            title: tool.title,
            status: value.status === "failed" ? "failed" : done ? "completed" : "inProgress",
            data: tool.data,
          },
        });
      }
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const state of states.values()) cancelPermissions(state);
        for (const connection of connections) connection.close();
        connections.clear();
        states.clear();
      }),
    );

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: options.driver,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession: (input) =>
        Effect.gen(function* () {
          if (states.has(input.threadId))
            return yield* invalid("startSession", "ACP session is already open.");
          const command = yield* resolveSpawnCommand(options.command, options.args, {
            env: options.environment,
          });
          const authSessionId = yield* currentAuthSessionId;
          const mcp = readMcpProviderSession(
            input.threadId,
            options.instanceId,
            authSessionId ?? undefined,
          );
          return yield* Effect.tryPromise({
            try: async (signal) => {
              const cursor = record(input.resumeCursor);
              if (
                input.resumeCursor !== undefined &&
                (cursor.kind !== "acp" ||
                  cursor.instanceId !== options.instanceId ||
                  cursor.threadId !== input.threadId ||
                  typeof cursor.sessionId !== "string" ||
                  !cursor.sessionId)
              ) {
                throw new Error(
                  "Invalid ACP resume cursor. Refusing to start a fresh conversation.",
                );
              }
              const projectFree = input.workspaceContext === "none";
              const cwd = projectFree
                ? NodePath.join(
                    options.stateDir,
                    "acp-workspaces",
                    NodeCrypto.createHash("sha256")
                      .update(`${options.instanceId}:${input.threadId}`)
                      .digest("hex"),
                  )
                : (input.cwd ?? (typeof cursor.cwd === "string" ? cursor.cwd : undefined));
              if (!cwd) throw new Error("ACP requires a workspace directory.");
              if (projectFree) NodeFS.mkdirSync(cwd, { recursive: true });
              if (cursor.cwd !== undefined && cursor.cwd !== cwd)
                throw new Error("ACP resume workspace changed. Refusing to lose context.");
              const connection = new AcpConnection(command, cwd, options.environment);
              connections.add(connection);
              const abort = () => connection.close();
              signal.addEventListener("abort", abort, { once: true });
              try {
                const init = await connection.request("initialize", {
                  protocolVersion: 1,
                  clientInfo: { name: "sparky", version: "1.1" },
                  clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: false,
                  },
                });
                if (init.protocolVersion !== 1)
                  throw new Error("Unsupported ACP protocol version.");
                const capabilities = record(init.agentCapabilities);
                const mcpServers =
                  mcp && record(capabilities.mcpCapabilities).http === true
                    ? [
                        {
                          name: "sparky",
                          type: "http",
                          url: mcp.endpoint,
                          headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                        },
                      ]
                    : [];
                const resuming = typeof cursor.sessionId === "string";
                if (resuming && capabilities.loadSession !== true)
                  throw new Error(
                    "This ACP harness cannot load saved sessions. Refusing to start a fresh conversation.",
                  );
                const result = await connection.request(resuming ? "session/load" : "session/new", {
                  cwd,
                  mcpServers,
                  ...(resuming ? { sessionId: cursor.sessionId } : {}),
                });
                const sessionId = resuming ? cursor.sessionId : result.sessionId;
                if (typeof sessionId !== "string" || !sessionId)
                  throw new Error("ACP returned no session identity.");
                const model = input.modelSelection?.model ?? "default";
                if (model !== "default")
                  await connection.request("session/set_model", { sessionId, modelId: model });
                const now = new Date().toISOString();
                const session: ProviderSession = {
                  provider: options.driver,
                  providerInstanceId: options.instanceId,
                  threadId: input.threadId,
                  runtimeMode: input.runtimeMode,
                  workspaceContext: input.workspaceContext ?? "project",
                  ...(projectFree ? {} : { cwd }),
                  model,
                  status: "ready",
                  createdAt: now,
                  updatedAt: now,
                  resumeCursor: {
                    kind: "acp",
                    instanceId: options.instanceId,
                    threadId: input.threadId,
                    sessionId,
                    cwd,
                  },
                };
                const modeInfo = record(result.modes);
                const availableModes = Array.isArray(modeInfo.availableModes)
                  ? modeInfo.availableModes
                  : [];
                const modeIds = availableModes.flatMap((mode) =>
                  typeof record(mode).id === "string" ? [String(record(mode).id)] : [],
                );
                const reportedCurrentMode =
                  typeof modeInfo.currentModeId === "string" ? modeInfo.currentModeId : undefined;
                const defaultMode =
                  reportedCurrentMode && reportedCurrentMode !== "plan"
                    ? reportedCurrentMode
                    : modeIds.find((id) => id !== "plan");
                const state: State = {
                  connection,
                  session,
                  sessionId,
                  cwd,
                  imageSupported: record(capabilities.promptCapabilities).image === true,
                  modes: new Set(modeIds),
                  defaultMode,
                  permissions: new Map(),
                  snapshot: { threadId: input.threadId, turns: [] },
                  active: undefined,
                  tools: new Map(),
                };
                connection.onNotification = (method, params) => {
                  if (method === "session/update") update(state, params);
                };
                connection.onRequest = async (method, params) => {
                  if (
                    method !== "session/request_permission" ||
                    params.sessionId !== sessionId ||
                    !state.active
                  )
                    throw new Error("Unsupported ACP request");
                  const requestId = RuntimeRequestId.make(NodeCrypto.randomUUID());
                  const tool = record(params.toolCall);
                  const permissionOptions = Array.isArray(params.options)
                    ? params.options.map(record)
                    : [];
                  const requestType =
                    tool.kind === "edit" ? "file_change_approval" : "command_execution_approval";
                  // Always go through Sparky's approval UI. Never infer permission from a mention.
                  return await new Promise((resolve) => {
                    state.permissions.set(requestId, {
                      resolve,
                      options: permissionOptions,
                      requestType,
                    });
                    emit({
                      type: "request.opened",
                      ...stamp(input.threadId, state.active?.turnId),
                      requestId,
                      payload: {
                        requestType,
                        detail:
                          typeof tool.title === "string" && tool.title
                            ? tool.title
                            : "Harness requests permission",
                        args: tool,
                      },
                    });
                  });
                };
                connection.onExit = (error) => {
                  finish(state, "failed", error.message);
                  state.session = { ...state.session, status: "closed" };
                  connections.delete(connection);
                  if (states.get(input.threadId) === state) states.delete(input.threadId);
                };
                states.set(input.threadId, state);
                return session;
              } catch (error) {
                connection.close();
                connections.delete(connection);
                throw error;
              } finally {
                signal.removeEventListener("abort", abort);
              }
            },
            catch: (cause) => failure("session/start", cause),
          });
        }),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const state = states.get(input.threadId);
          if (!state) return yield* missing(input.threadId);
          if (state.active) return yield* invalid("sendTurn", "ACP already has an active turn.");
          if (state.session.status === "closed" || state.session.status === "error")
            return yield* invalid("sendTurn", "Reconnect the ACP session before sending.");
          if (input.modelSelection && input.modelSelection.model !== state.session.model)
            return yield* invalid("sendTurn", "Start a new thread to change harness models.");
          if (!input.input?.trim() && !input.attachments?.length)
            return yield* invalid("sendTurn", "ACP requires a prompt.");
          const requestedMode = input.interactionMode === "plan" ? "plan" : state.defaultMode;
          if (input.interactionMode === "plan" && !state.modes.has("plan"))
            return yield* invalid("sendTurn", "This harness does not advertise plan mode.");
          const prompt = yield* Effect.try({
            try: () => {
              const blocks: Record<string, unknown>[] = input.input
                ? [{ type: "text", text: input.input }]
                : [];
              for (const attachment of input.attachments ?? []) {
                if (!state.imageSupported)
                  throw new Error("This ACP harness does not support images.");
                const path = resolveAttachmentPath({
                  attachmentsDir: options.attachmentsDir,
                  attachment,
                });
                if (!path) throw new Error("Harness attachment could not be loaded.");
                blocks.push({
                  type: "image",
                  mimeType: attachment.mimeType,
                  data: NodeFS.readFileSync(path).toString("base64"),
                });
              }
              return blocks;
            },
            catch: (cause) => failure("session/prompt", cause),
          });
          if (requestedMode)
            yield* Effect.tryPromise({
              try: () =>
                state.connection.request("session/set_mode", {
                  sessionId: state.sessionId,
                  modeId: requestedMode,
                }),
              catch: (cause) => failure("session/set_mode", cause),
            });
          const turnId = TurnId.make(`acp-${NodeCrypto.randomUUID()}`);
          state.tools.clear();
          state.active = {
            turnId,
            itemId: RuntimeItemId.make(`${turnId}-assistant`),
            text: "",
            started: false,
          };
          state.session = {
            ...state.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: new Date().toISOString(),
          };
          emit({
            type: "turn.started",
            ...stamp(input.threadId, turnId),
            payload: { model: state.session.model },
          });
          // Terminal prompt response settles the UI; the ACP process intentionally stays alive.
          void state.connection
            .request("session/prompt", { sessionId: state.sessionId, prompt }, 30 * 60_000)
            .then(
              (result) =>
                finish(state, result.stopReason === "cancelled" ? "interrupted" : "completed"),
              (error: unknown) =>
                finish(
                  state,
                  "failed",
                  error instanceof Error ? error.message : "ACP prompt failed",
                ),
            );
          return { threadId: input.threadId, turnId, resumeCursor: state.session.resumeCursor };
        }),
      interruptTurn: (threadId, turnId) =>
        Effect.sync(() => {
          const state = states.get(threadId);
          if (!state?.active || (turnId && state.active.turnId !== turnId)) return;
          finish(state, "interrupted");
          // Killing is definitive: a non-cooperative harness must not keep editing after Stop.
          state.connection.close();
        }),
      respondToRequest: (threadId, requestId, decision) => {
        const state = states.get(threadId);
        if (!state) return missing(threadId);
        const permission = state.permissions.get(requestId);
        if (!permission) return invalid("respondToRequest", "Unknown ACP permission request.");
        const cancel = decision === "cancel";
        const kind =
          decision === "accept"
            ? "allow_once"
            : decision === "acceptForSession"
              ? "allow_always"
              : "reject_once";
        const selected = cancel
          ? undefined
          : (permission.options.find((option) => option.kind === kind) ??
            permission.options.find(
              (option) => option.kind === (kind === "allow_always" ? "allow_once" : "reject_once"),
            ));
        if (
          (decision === "accept" || decision === "acceptForSession") &&
          (!selected || !String(selected.kind).startsWith("allow_"))
        ) {
          return invalid(
            "respondToRequest",
            "Harness did not offer the requested permission option.",
          );
        }
        return Effect.sync(() => {
          state.permissions.delete(requestId);
          permission.resolve({
            outcome:
              typeof selected?.optionId === "string"
                ? { outcome: "selected", optionId: selected.optionId }
                : { outcome: "cancelled" },
          });
          emit({
            type: "request.resolved",
            ...stamp(threadId, state.active?.turnId),
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: permission.requestType, decision },
          });
        });
      },
      respondToUserInput: () =>
        invalid("respondToUserInput", "ACP does not expose structured user input."),
      stopSession: (threadId) =>
        Effect.sync(() => {
          const state = states.get(threadId);
          if (!state) return;
          finish(state, "interrupted");
          cancelPermissions(state);
          state.connection.close();
          states.delete(threadId);
        }),
      listSessions: () => Effect.sync(() => [...states.values()].map((state) => state.session)),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const state = states.get(threadId);
          return !!state && state.session.status !== "closed" && state.session.status !== "error";
        }),
      readThread: (threadId) =>
        states.has(threadId) ? Effect.succeed(states.get(threadId)!.snapshot) : missing(threadId),
      rollbackThread: () =>
        invalid("rollbackThread", "This ACP harness does not support durable rollback."),
      stopAll: () =>
        Effect.sync(() => {
          for (const state of states.values()) {
            finish(state, "interrupted");
            cancelPermissions(state);
          }
          for (const connection of connections) connection.close();
          connections.clear();
          states.clear();
        }),
      subscribeEvents: PubSub.subscribe(events),
      streamEvents: Stream.fromPubSub(events),
    };
    return adapter;
  });
