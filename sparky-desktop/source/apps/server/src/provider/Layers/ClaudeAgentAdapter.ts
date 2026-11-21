// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
/**
 * ClaudeAgentAdapter: the Claude Code provider. Sparky is the ACP client, and the
 * Claude ACP adapter (`claude-agent-acp` by default) runs the unmodified Claude
 * Code harness. Sparky's tools reach Claude Code as a local MCP server, passed
 * through ACP `session/new` and `session/resume`.
 *
 * Design notes:
 *   - One adapter process runs per turn, and each turn resumes the saved ACP
 *     session with the persisted session id. A follow-up therefore continues the
 *     same conversation, including after a server restart. Each turn also carries a
 *     freshly issued Sparky MCP credential, since ProviderService re-issues it per
 *     turn.
 *   - Sparky reads, stores, and forwards no credential. Sign-in belongs to Claude
 *     Code. Environment variables come only from the provider instance's settings.
 *
 * @module provider/Layers/ClaudeAgentAdapter
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  ContentBlock,
  McpServer,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ProviderWorkspaceContext,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { SPARKY_CLAUDE_AGENT_SKILL } from "../../claudeAgent/ClaudeAgentSkill.ts";
import { buildClaudeAcpEnvironment } from "../../claudeAcp/ClaudeAcpEnvironment.ts";
import {
  ClaudeAcpProcess,
  claudeAcpLaunchFailureMessage,
  type ClaudeAcpLaunch,
} from "../../claudeAcp/ClaudeAcpProcess.ts";
import {
  claudeToolNameOf,
  makeClaudeAcpMapper,
  type ClaudeAcpEventDraft,
} from "../../claudeAcp/ClaudeAcpEvents.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { currentAuthSessionId } from "../ProviderExecutionContext.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

export const CLAUDE_AGENT_PROVIDER = ProviderDriverKind.make("claudeAgent");

/** Resume state the adapter stores in `resumeCursor`. Parsed only here. */
export interface ClaudeAgentResumeCursor {
  readonly version: 1;
  readonly sessionId: string;
}

export function readClaudeAgentResumeCursor(value: unknown): ClaudeAgentResumeCursor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.sessionId !== "string") return undefined;
  const sessionId = record.sessionId.trim();
  return sessionId.length > 0 ? { version: 1, sessionId } : undefined;
}

export interface ClaudeAgentAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  /** Adapter executable. Default `claude-agent-acp`. */
  readonly command: string;
  readonly args?: ReadonlyArray<string> | undefined;
  /** Variables the user set on this provider instance. */
  readonly instanceEnvironment?:
    | ReadonlyArray<{ readonly name: string; readonly value: string }>
    | undefined;
  /** Host environment. Only the allow-listed variables reach the adapter. */
  readonly ambientEnvironment?: NodeJS.ProcessEnv | undefined;
  readonly attachmentsDir: string;
  /** Composed Sparky instructions (personality and custom instructions). */
  readonly getCustomInstructions?: (() => Effect.Effect<string>) | undefined;
}

interface PendingApproval {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly options: ReadonlyArray<PermissionOption>;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  completed: boolean;
  proc: ClaudeAcpProcess | undefined;
  acpSessionId: string | undefined;
  cancelRequested: boolean;
}

interface ClaudeAgentSessionState {
  session: ProviderSession;
  /** ACP session id from the last turn, persisted in `resumeCursor`. */
  acpSessionId: string | undefined;
  workspaceContext: ProviderWorkspaceContext;
  activeTurn: ActiveTurn | undefined;
}

const notSupported = (operation: string, detail: string) =>
  new ProviderAdapterRequestError({
    provider: CLAUDE_AGENT_PROVIDER,
    method: operation,
    detail,
  });

const SIGN_IN_MESSAGE =
  "Claude Code is not signed in. Run `claude` in a terminal and use /login, or set ANTHROPIC_API_KEY in this provider's environment.";

/** Failure text shown in the thread, with the sign-in step when that is the cause. */
function failureMessage(command: string, error: unknown): string {
  const launch = claudeAcpLaunchFailureMessage(command, error);
  if (launch) return launch;
  const message = error instanceof Error ? error.message : String(error);
  // The ACP SDK reports an adapter error as "Internal error" with the real text in `data`.
  const data = (error as { readonly data?: unknown } | undefined)?.data;
  const details = typeof data === "string" ? data : data === undefined ? "" : JSON.stringify(data);
  if (/auth|sign.?in|log.?in|credential|api key/i.test(`${message} ${details}`))
    return SIGN_IN_MESSAGE;
  return message;
}

/** Choose the ACP option for a Sparky decision, falling back to a cancellation. */
export function permissionResponseFor(
  decision: ProviderApprovalDecision,
  options: ReadonlyArray<PermissionOption>,
): RequestPermissionResponse {
  const preferred: Record<ProviderApprovalDecision, ReadonlyArray<PermissionOption["kind"]>> = {
    accept: ["allow_once", "allow_always"],
    acceptForSession: ["allow_always", "allow_once"],
    decline: ["reject_once", "reject_always"],
    cancel: [],
  };
  for (const kind of preferred[decision]) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/** The first allow option, for runtime modes that approve tools automatically. */
export function autoApproveResponse(
  options: ReadonlyArray<PermissionOption>,
): RequestPermissionResponse {
  return permissionResponseFor("accept", options);
}

export const makeClaudeAgentAdapter = (options: ClaudeAgentAdapterOptions) =>
  Effect.gen(function* () {
    yield* Scope.Scope;
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, ClaudeAgentSessionState>();
    const pendingApprovals = new Map<string, PendingApproval>();
    const ambient = options.ambientEnvironment ?? process.env;

    const stamp = (threadId: ThreadId, turnId?: TurnId) => ({
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: CLAUDE_AGENT_PROVIDER,
      providerInstanceId: options.instanceId,
      threadId,
      createdAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
    });

    const publishDraft = (threadId: ThreadId, turnId: TurnId, draft: ClaudeAcpEventDraft) => {
      const event = {
        ...stamp(threadId, turnId),
        type: draft.type,
        ...(draft.itemId ? { itemId: RuntimeItemId.make(draft.itemId) } : {}),
        payload: draft.payload,
      } as unknown as ProviderRuntimeEvent;
      Effect.runSync(PubSub.publish(runtimeEvents, event));
    };

    const publishRaw = (event: Record<string, unknown>) =>
      Effect.runSync(PubSub.publish(runtimeEvents, event as unknown as ProviderRuntimeEvent));

    const requireSession = (threadId: ThreadId) => {
      const state = sessions.get(threadId);
      if (!state) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: CLAUDE_AGENT_PROVIDER,
            threadId: String(threadId),
          }),
        );
      }
      return Effect.succeed(state);
    };

    const launchFor = (cwd: string): ClaudeAcpLaunch => ({
      command: options.command,
      args: options.args ?? [],
      cwd,
      env: buildClaudeAcpEnvironment({
        ambient,
        ...(options.instanceEnvironment ? { instanceOverrides: options.instanceEnvironment } : {}),
      }),
    });

    const runTurn = async (input: {
      readonly state: ClaudeAgentSessionState;
      readonly turn: ActiveTurn;
      readonly blocks: ReadonlyArray<ContentBlock>;
      readonly mcpServers: ReadonlyArray<McpServer>;
      readonly cwd: string;
    }) => {
      const { state, turn } = input;
      const threadId = state.session.threadId;
      const turnId = turn.turnId;
      const mapper = makeClaudeAcpMapper({ turnKey: String(turnId) });

      const finishTurn = (
        stateValue: "completed" | "failed" | "interrupted",
        errorMessage?: string,
      ) => {
        if (turn.completed) return;
        turn.completed = true;
        if (stateValue === "failed" && errorMessage) {
          publishRaw({
            ...stamp(threadId, turnId),
            type: "runtime.error",
            payload: { message: errorMessage, class: "provider_error" },
          });
        }
        publishRaw({
          ...stamp(threadId, turnId),
          type: "turn.completed",
          payload: {
            state: stateValue,
            ...(errorMessage ? { errorMessage } : {}),
          },
        });
      };

      const onPermission = async (
        request: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        const toolName =
          mapper.toolNameFor(request.toolCall.toolCallId) ?? claudeToolNameOf(request.toolCall);
        if (state.session.runtimeMode === "full-access") {
          return autoApproveResponse(request.options);
        }
        const requestId = NodeCrypto.randomUUID();
        const decision = await new Promise<ProviderApprovalDecision>((resolve) => {
          pendingApprovals.set(requestId, { threadId, turnId, options: request.options, resolve });
          publishRaw({
            ...stamp(threadId, turnId),
            type: "request.opened",
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              requestType: approvalKindFor(toolName),
              detail: request.toolCall.title ?? `Claude wants to use ${toolName}`,
              args: request.toolCall.rawInput,
            },
          });
        });
        pendingApprovals.delete(requestId);
        publishRaw({
          ...stamp(threadId, turnId),
          type: "request.resolved",
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: approvalKindFor(toolName), decision },
        });
        return permissionResponseFor(decision, request.options);
      };

      let proc: ClaudeAcpProcess | undefined;
      try {
        proc = await ClaudeAcpProcess.start(launchFor(input.cwd), {
          onUpdate: (notification) => {
            for (const draft of mapper.map(notification.update)) {
              publishDraft(threadId, turnId, draft);
            }
          },
          onPermission,
        });
        turn.proc = proc;
        await proc.initialize();

        let sessionId = state.acpSessionId;
        if (sessionId) {
          try {
            await proc.resumeSession({ sessionId, cwd: input.cwd, mcpServers: input.mcpServers });
          } catch {
            // The stored session is gone. Start a new one; the caller already
            // sent the conversation's instructions with the first turn.
            sessionId = undefined;
          }
        }
        if (!sessionId) {
          const created = await proc.newSession({ cwd: input.cwd, mcpServers: input.mcpServers });
          sessionId = created.sessionId;
        }
        state.acpSessionId = sessionId;
        turn.acpSessionId = sessionId;

        const response = await proc.prompt({ sessionId, prompt: input.blocks });
        for (const draft of mapper.flush()) publishDraft(threadId, turnId, draft);
        finishTurn(...turnOutcome(response.stopReason));
      } catch (error) {
        for (const draft of mapper.flush()) publishDraft(threadId, turnId, draft);
        if (turn.cancelRequested) {
          finishTurn("interrupted");
        } else {
          finishTurn("failed", failureMessage(options.command, error));
        }
      } finally {
        proc?.close();
        if (state.activeTurn === turn) state.activeTurn = undefined;
        state.session = {
          ...state.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: new Date().toISOString(),
          ...(state.acpSessionId
            ? {
                resumeCursor: {
                  version: 1,
                  sessionId: state.acpSessionId,
                } satisfies ClaudeAgentResumeCursor,
              }
            : {}),
        };
        for (const [requestId, pending] of pendingApprovals) {
          if (pending.turnId === turnId) {
            pendingApprovals.delete(requestId);
            pending.resolve("cancel");
          }
        }
      }
    };

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: CLAUDE_AGENT_PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },

      startSession: (input: ProviderSessionStartInput) =>
        Effect.gen(function* () {
          const workspaceContext: ProviderWorkspaceContext = input.workspaceContext ?? "project";
          const cwd =
            input.cwd ??
            (workspaceContext === "none"
              ? projectFreeCwd(options.attachmentsDir, input.threadId)
              : process.cwd());
          NodeFS.mkdirSync(cwd, { recursive: true });
          const cursor = readClaudeAgentResumeCursor(input.resumeCursor);
          const now = new Date().toISOString();
          const session: ProviderSession = {
            provider: CLAUDE_AGENT_PROVIDER,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            workspaceContext,
            cwd,
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
            ...(cursor ? { resumeCursor: cursor } : {}),
          };
          sessions.set(input.threadId, {
            session,
            acpSessionId: cursor?.sessionId,
            workspaceContext,
            activeTurn: undefined,
          });
          return session;
        }),

      sendTurn: (input: ProviderSendTurnInput) =>
        Effect.gen(function* () {
          const state = yield* requireSession(input.threadId);
          if (state.activeTurn && !state.activeTurn.completed) {
            return yield* Effect.fail(
              notSupported("sendTurn", "A Claude Code turn is already running in this thread."),
            );
          }
          const prompt = input.input?.trim() ?? "";
          if (prompt.length === 0) {
            return yield* Effect.fail(
              new ProviderAdapterValidationError({
                provider: CLAUDE_AGENT_PROVIDER,
                operation: "sendTurn",
                issue: "A message is required.",
              }),
            );
          }
          // Images go to Claude Code as ACP image blocks. A missing file fails the turn.
          const imageBlocks = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
            Effect.gen(function* () {
              const path = resolveAttachmentPath({
                attachmentsDir: options.attachmentsDir,
                attachment,
              });
              if (!path || !NodeFS.existsSync(path)) {
                return yield* new ProviderAdapterRequestError({
                  provider: CLAUDE_AGENT_PROVIDER,
                  method: "sendTurn",
                  detail: `Attachment '${attachment.name}' could not be loaded.`,
                });
              }
              const data = NodeFS.readFileSync(path).toString("base64");
              return { type: "image" as const, data, mimeType: attachment.mimeType };
            }),
          );
          const authSessionId = yield* currentAuthSessionId;
          const mcpSession =
            state.workspaceContext === "none"
              ? undefined
              : McpProviderSession.readMcpProviderSession(
                  input.threadId,
                  options.instanceId,
                  authSessionId ?? undefined,
                );
          const mcpServers: McpServer[] = mcpSession
            ? [
                {
                  type: "http",
                  name: "sparky",
                  url: mcpSession.endpoint,
                  headers: [{ name: "Authorization", value: mcpSession.authorizationHeader }],
                },
              ]
            : [];
          const customInstructions = options.getCustomInstructions
            ? yield* options.getCustomInstructions()
            : "";
          // ACP has no system prompt field, so Sparky's instructions lead the first
          // prompt of a new ACP session. Resumed sessions already carry them.
          const instructions = [customInstructions, SPARKY_CLAUDE_AGENT_SKILL]
            .filter((part) => part.trim().length > 0)
            .join("\n\n");
          const leading = state.acpSessionId ? "" : `${instructions}\n\n`;
          const blocks: ContentBlock[] = [
            { type: "text", text: `${leading}${prompt}` },
            ...imageBlocks,
          ];
          if (input.modelSelection?.model) {
            state.session = { ...state.session, model: input.modelSelection.model };
          }
          const turnId = TurnId.make(NodeCrypto.randomUUID());
          const turn: ActiveTurn = {
            turnId,
            completed: false,
            proc: undefined,
            acpSessionId: undefined,
            cancelRequested: false,
          };
          state.activeTurn = turn;
          state.session = {
            ...state.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: new Date().toISOString(),
          };
          publishRaw({
            ...stamp(input.threadId, turnId),
            type: "turn.started",
            payload: state.session.model ? { model: state.session.model } : {},
          });
          // The turn runs in the background; the RPC returns once it has started.
          void runTurn({
            state,
            turn,
            blocks,
            mcpServers,
            cwd: state.session.cwd ?? process.cwd(),
          });
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: state.acpSessionId
              ? ({ version: 1, sessionId: state.acpSessionId } satisfies ClaudeAgentResumeCursor)
              : undefined,
          } satisfies ProviderTurnStartResult;
        }),

      interruptTurn: (threadId) =>
        Effect.gen(function* () {
          const state = yield* requireSession(threadId);
          const turn = state.activeTurn;
          if (!turn || turn.completed) return;
          turn.cancelRequested = true;
          if (turn.proc && turn.acpSessionId) {
            yield* Effect.promise(() => turn.proc!.cancel(turn.acpSessionId!));
          }
        }),

      respondToRequest: (threadId, requestId: ApprovalRequestId, decision) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          const pending = pendingApprovals.get(String(requestId));
          if (!pending || pending.threadId !== threadId) {
            return yield* Effect.fail(
              notSupported("respondToRequest", `No pending approval ${String(requestId)}.`),
            );
          }
          pending.resolve(decision);
        }),

      respondToUserInput: (
        threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _answers: ProviderUserInputAnswers,
      ) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          return yield* Effect.fail(
            notSupported(
              "respondToUserInput",
              "Claude Code's structured questions are not available through the ACP adapter yet.",
            ),
          );
        }),

      stopSession: (threadId) =>
        Effect.gen(function* () {
          const state = sessions.get(threadId);
          if (!state) return;
          const turn = state.activeTurn;
          if (turn) {
            turn.cancelRequested = true;
            turn.proc?.close();
          }
          sessions.delete(threadId);
          for (const [requestId, pending] of pendingApprovals) {
            if (pending.threadId === threadId) {
              pendingApprovals.delete(requestId);
              pending.resolve("cancel");
            }
          }
        }),

      listSessions: () => Effect.sync(() => [...sessions.values()].map((state) => state.session)),

      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),

      readThread: (threadId) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          return { threadId, turns: [] } satisfies ProviderThreadSnapshot;
        }),

      rollbackThread: (_threadId, _numTurns) =>
        Effect.fail(
          notSupported(
            "rollbackThread",
            "Rolling back Claude Code turns is not supported. Start a new thread from the checkpoint instead.",
          ),
        ),

      stopAll: () =>
        Effect.sync(() => {
          for (const state of sessions.values()) {
            const turn = state.activeTurn;
            if (turn) {
              turn.cancelRequested = true;
              turn.proc?.close();
            }
          }
          sessions.clear();
          for (const [requestId, pending] of pendingApprovals) {
            pendingApprovals.delete(requestId);
            pending.resolve("cancel");
          }
        }),

      streamEvents: Stream.fromPubSub(runtimeEvents),
      subscribeEvents: PubSub.subscribe(runtimeEvents),
    };

    return adapter;
  });

/** Map an ACP stop reason to the turn outcome Sparky records. */
export function turnOutcome(
  stopReason: StopReason,
): ["completed" | "failed" | "interrupted", string | undefined] {
  switch (stopReason) {
    case "end_turn":
      return ["completed", undefined];
    case "cancelled":
      return ["interrupted", undefined];
    case "refusal":
      return ["failed", "Claude declined this request."];
    case "max_tokens":
      return ["failed", "Claude reached its output limit."];
    case "max_turn_requests":
      return ["failed", "Claude reached its turn limit."];
    default:
      return ["failed", `Claude stopped unexpectedly (${String(stopReason)}).`];
  }
}

/** Sparky approval kind for a Claude Code tool name. */
export function approvalKindFor(
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

function projectFreeCwd(attachmentsDir: string, threadId: ThreadId): string {
  return NodePath.join(attachmentsDir, "claude-agent", "projectless", String(threadId));
}
