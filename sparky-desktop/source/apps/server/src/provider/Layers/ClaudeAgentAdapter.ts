// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
/**
 * ClaudeAgentAdapter: runs Claude Code through the Claude Agent SDK and adapts it
 * to Sparky's provider adapter contract.
 *
 * Design notes:
 *   - One SDK `query()` runs per turn and resumes the Claude Code transcript with
 *     the persisted session id (`resumeCursor`). A follow-up in the same thread
 *     therefore continues the same conversation, including after a server restart.
 *     Per-turn queries also let each turn carry a freshly issued Sparky MCP
 *     credential, since ProviderService re-issues it on every turn.
 *   - Authentication is an Anthropic Console API key only. The adapter verifies the
 *     SDK-reported `apiKeySource` and stops the turn if it is anything else.
 *   - Sparky's tools are reached over the existing `/mcp` bridge (see
 *     `mcp/McpProviderSession.ts`), so Claude Code gets computer use, the browser,
 *     html_render boxes, plugins and thread tools.
 *
 * @module provider/Layers/ClaudeAgentAdapter
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  query as sdkQuery,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
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
  type ModelSelection,
  type ProviderWorkspaceContext,
} from "@sparky/contracts";
import { getModelSelectionStringOptionValue } from "@sparky/shared/model";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  buildClaudeAgentOptions,
  isAcceptedClaudeAgentApiKeySource,
  resolveClaudeAgentApiKey,
  type ClaudeAgentAuthMode,
} from "../../claudeAgent/ClaudeAgentOptions.ts";
import { CLAUDE_SIGN_IN_COMMAND } from "../../claudeAgent/ClaudeAgentAccount.ts";
import {
  claudeAgentRequestType,
  makeClaudeAgentMapper,
  type ClaudeAgentEventDraft,
} from "../../claudeAgent/ClaudeAgentEvents.ts";
import { SPARKY_CLAUDE_AGENT_SKILL } from "../../claudeAgent/ClaudeAgentSkill.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { currentAuthSessionId } from "../ProviderExecutionContext.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

export const CLAUDE_AGENT_PROVIDER = ProviderDriverKind.make("claudeAgent");

type ClaudeAgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
const CLAUDE_AGENT_EFFORTS: ReadonlyArray<ClaudeAgentEffort> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Sparky's reasoning-effort option, when it is one Claude Code accepts. */
export function resolveClaudeAgentEffort(
  modelSelection: ModelSelection | undefined,
): ClaudeAgentEffort | undefined {
  if (!modelSelection) return undefined;
  const value = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  return CLAUDE_AGENT_EFFORTS.find((effort) => effort === value);
}

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

export type ClaudeAgentQueryFn = (input: {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}) => Query;

/** One structured question from Claude Code's AskUserQuestion tool. */
export interface ClaudeAgentUserQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect: boolean;
}

/**
 * Turn a text plus optional image blocks into the single streamed user message
 * the SDK expects when a prompt is not a plain string.
 */
function singleUserMessage(content: ReadonlyArray<unknown>): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage;
  })();
}

/** Parse AskUserQuestion input into Sparky questions. Empty entries are dropped. */
export function parseClaudeAgentUserQuestions(
  toolInput: Record<string, unknown>,
): ReadonlyArray<ClaudeAgentUserQuestion> {
  const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  return rawQuestions
    .map((raw, index): ClaudeAgentUserQuestion => {
      const record = (raw ?? {}) as Record<string, unknown>;
      const rawOptions = Array.isArray(record.options) ? record.options : [];
      return {
        id: `question-${index + 1}`,
        header: String(record.header ?? "").trim() || `Question ${index + 1}`,
        question: String(record.question ?? "").trim(),
        options: rawOptions
          .map((option) => {
            const optionRecord = (option ?? {}) as Record<string, unknown>;
            const label = String(optionRecord.label ?? "").trim();
            const description = String(optionRecord.description ?? "").trim() || label;
            return { label, description };
          })
          .filter((option) => option.label.length > 0),
        multiSelect: record.multiSelect === true,
      };
    })
    .filter((question) => question.question.length > 0 && question.options.length > 0);
}

export interface ClaudeAgentAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  /** Environment of the provider instance, with Models settings applied. */
  readonly environment: NodeJS.ProcessEnv;
  readonly attachmentsDir: string;
  /** Composed Sparky instructions (personality and custom instructions). */
  readonly getCustomInstructions?: (() => Effect.Effect<string>) | undefined;
  /** Injection point for tests. Defaults to the Agent SDK's `query`. */
  readonly queryFn?: ClaudeAgentQueryFn | undefined;
  /** Optional Claude Code executable override (e.g. a bundled binary). */
  readonly pathToClaudeCodeExecutable?: string | undefined;
  /**
   * `claudeAccount` (default in the driver): the user's own signed-in Claude Code.
   * `apiKey`: a Console API key from Models settings. Defaults to `apiKey` here so
   * direct callers keep the stricter behavior.
   */
  readonly authMode?: ClaudeAgentAuthMode | undefined;
}

/** Credential the runtime may use for this turn, decided by the auth mode. */
type RuntimeCredential =
  | { readonly ok: true; readonly apiKey: string | undefined }
  | { readonly ok: false; readonly reason: string };

interface PendingApproval {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
}

interface PendingUserInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly questions: ReadonlyArray<ClaudeAgentUserQuestion>;
  /** Answers keyed by question id, or null when the question was abandoned. */
  readonly resolve: (answers: Record<string, string> | null) => void;
}

interface ClaudeAgentSessionState {
  session: ProviderSession;
  sessionId: string | undefined;
  workspaceContext: ProviderWorkspaceContext;
  activeTurn:
    | {
        readonly turnId: TurnId;
        readonly abortController: AbortController;
        completed: boolean;
      }
    | undefined;
}

const notSupported = (operation: string, detail: string) =>
  new ProviderAdapterRequestError({
    provider: CLAUDE_AGENT_PROVIDER,
    method: operation,
    detail,
  });

export const makeClaudeAgentAdapter = (options: ClaudeAgentAdapterOptions) =>
  Effect.gen(function* () {
    yield* Scope.Scope;
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, ClaudeAgentSessionState>();
    const pendingApprovals = new Map<string, PendingApproval>();
    const pendingUserInputs = new Map<string, PendingUserInput>();
    const authMode: ClaudeAgentAuthMode = options.authMode ?? "apiKey";
    const resolveRuntimeCredential = (): RuntimeCredential => {
      if (authMode === "claudeAccount") return { ok: true, apiKey: undefined };
      const credential = resolveClaudeAgentApiKey(options.environment);
      return credential.ok
        ? { ok: true, apiKey: credential.apiKey }
        : { ok: false, reason: credential.reason };
    };
    const queryFn: ClaudeAgentQueryFn =
      options.queryFn ??
      ((input) =>
        sdkQuery({
          prompt: input.prompt,
          options: input.options,
        }));

    const stamp = (threadId: ThreadId, turnId?: TurnId) => ({
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: CLAUDE_AGENT_PROVIDER,
      providerInstanceId: options.instanceId,
      threadId,
      createdAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
    });

    const publishDraft = (threadId: ThreadId, turnId: TurnId, draft: ClaudeAgentEventDraft) => {
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

    /**
     * AskUserQuestion is answered by the user in Sparky, not by Claude Code's
     * terminal. The answers go back to Claude as the tool's `answers` input, keyed
     * by question text, which is the format Claude Code's tool expects.
     */
    const askUserQuestions = async (
      threadId: ThreadId,
      turnId: TurnId,
      toolInput: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<PermissionResult> => {
      const questions = parseClaudeAgentUserQuestions(toolInput);
      if (questions.length === 0) {
        return { behavior: "deny", message: "The question had no usable options." };
      }
      const requestId = NodeCrypto.randomUUID();
      const answers = await new Promise<Record<string, string> | null>((resolve) => {
        pendingUserInputs.set(requestId, { threadId, turnId, questions, resolve });
        signal.addEventListener("abort", () => resolve(null), { once: true });
        publishRaw({
          ...stamp(threadId, turnId),
          type: "user-input.requested",
          requestId: RuntimeRequestId.make(requestId),
          payload: { questions },
        });
      });
      pendingUserInputs.delete(requestId);
      if (!answers) {
        return { behavior: "deny", message: "The user did not answer the question." };
      }
      publishRaw({
        ...stamp(threadId, turnId),
        type: "user-input.resolved",
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers },
      });
      const answersByQuestion = Object.fromEntries(
        questions.map((question) => [question.question, answers[question.id] ?? ""]),
      );
      return {
        behavior: "allow",
        updatedInput: { ...toolInput, answers: answersByQuestion },
      };
    };

    const runTurn = async (input: {
      readonly state: ClaudeAgentSessionState;
      readonly turnId: TurnId;
      readonly prompt: string | AsyncIterable<SDKUserMessage>;
      readonly environment: NodeJS.ProcessEnv;
      readonly mcp: McpProviderSession.McpProviderSessionConfig | undefined;
      readonly instructions: string;
      readonly runtimeMode: ProviderSession["runtimeMode"];
      /** Console API key in `apiKey` mode; undefined when the CLI's own sign-in is used. */
      readonly apiKey: string | undefined;
      readonly planMode: boolean;
      readonly effort: ClaudeAgentEffort | undefined;
    }) => {
      const { state, turnId } = input;
      const threadId = state.session.threadId;
      const abortController = new AbortController();
      const turn = { turnId, abortController, completed: false };
      state.activeTurn = turn;
      const mapper = makeClaudeAgentMapper({ turnKey: String(turnId) });
      const failTurn = (message: string) => {
        if (turn.completed) return;
        turn.completed = true;
        publishRaw({
          ...stamp(threadId, turnId),
          type: "runtime.error",
          payload: { message, class: "provider_error" },
        });
        publishRaw({
          ...stamp(threadId, turnId),
          type: "turn.completed",
          payload: { state: "failed", errorMessage: message },
        });
      };

      const canUseTool: NonNullable<Options["canUseTool"]> = async (toolName, toolInput, ctx) => {
        // Questions always need the user, even in full-access mode.
        if (toolName === "AskUserQuestion") {
          return askUserQuestions(threadId, turnId, toolInput, ctx.signal);
        }
        // A finished plan is a decision for the user, so ExitPlanMode always asks,
        // even in full-access mode.
        if (toolName === "ExitPlanMode") {
          const plan = typeof toolInput.plan === "string" ? toolInput.plan.trim() : "";
          if (plan.length > 0) {
            publishRaw({
              ...stamp(threadId, turnId),
              type: "turn.proposed.completed",
              payload: { planMarkdown: plan },
            });
          }
        } else if (input.runtimeMode === "full-access") {
          return { behavior: "allow", updatedInput: toolInput };
        }
        const requestId = NodeCrypto.randomUUID();
        const decision = await new Promise<ProviderApprovalDecision>((resolve) => {
          pendingApprovals.set(requestId, { threadId, turnId, resolve });
          ctx.signal.addEventListener("abort", () => resolve("cancel"), { once: true });
          publishRaw({
            ...stamp(threadId, turnId),
            type: "request.opened",
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              requestType: claudeAgentRequestType(toolName),
              detail: `Claude wants to use ${toolName}`,
              args: toolInput,
            },
          });
        });
        pendingApprovals.delete(requestId);
        publishRaw({
          ...stamp(threadId, turnId),
          type: "request.resolved",
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            requestType: claudeAgentRequestType(toolName),
            decision,
          },
        });
        if (decision === "accept" || decision === "acceptForSession") {
          return { behavior: "allow", updatedInput: toolInput };
        }
        return {
          behavior: "deny",
          message: "Declined in Sparky.",
          interrupt: decision === "cancel",
        };
      };

      const resume = state.sessionId;
      const sdkOptions = buildClaudeAgentOptions({
        cwd: state.session.cwd ?? process.cwd(),
        model: state.session.model,
        apiKey: input.apiKey,
        environment: input.environment,
        sparkyMcp: input.mcp
          ? { endpoint: input.mcp.endpoint, authorizationHeader: input.mcp.authorizationHeader }
          : undefined,
        systemPromptAppend: input.instructions,
        permissionMode: input.planMode ? "plan" : "default",
        effort: input.effort,
        resumeSessionId: resume,
        abortController,
        canUseTool,
        ...(options.pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }
          : {}),
      });

      let sawInit = false;
      try {
        const stream = queryFn({ prompt: input.prompt, options: sdkOptions });
        for await (const message of stream as AsyncIterable<SDKMessage>) {
          if (message.type === "system" && message.subtype === "init") {
            sawInit = true;
            if (!isAcceptedClaudeAgentApiKeySource(message.apiKeySource, authMode)) {
              abortController.abort();
              failTurn(
                authMode === "claudeAccount"
                  ? `Claude Code is not signed in with a Claude account. Run \`${CLAUDE_SIGN_IN_COMMAND}\` in a terminal, then try again.`
                  : "Claude Code is not using a Sparky API key. Sparky only runs Claude Code with an Anthropic Console API key.",
              );
              break;
            }
            state.sessionId = message.session_id;
          }
          // Mark the turn complete before publishing its terminal event, so a
          // follow-up sent as soon as the event arrives is not rejected as busy.
          if (message.type === "result") {
            turn.completed = true;
            state.sessionId = message.session_id;
          }
          for (const draft of mapper.map(message)) {
            publishDraft(threadId, turnId, draft);
          }
          if (message.type === "result") break;
        }
        if (!turn.completed) {
          const result = mapper.result();
          if (result) {
            turn.completed = true;
            if (result.sessionId) state.sessionId = result.sessionId;
          } else if (abortController.signal.aborted) {
            turn.completed = true;
            publishRaw({
              ...stamp(threadId, turnId),
              type: "turn.completed",
              payload: { state: "interrupted" },
            });
          } else {
            failTurn(
              sawInit
                ? "Claude Code ended without a result."
                : "Claude Code did not start a session.",
            );
          }
        }
      } catch (error) {
        if (abortController.signal.aborted && !turn.completed) {
          turn.completed = true;
          publishRaw({
            ...stamp(threadId, turnId),
            type: "turn.completed",
            payload: { state: "interrupted" },
          });
        } else {
          failTurn(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (state.activeTurn === turn) state.activeTurn = undefined;
        state.session = {
          ...state.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: new Date().toISOString(),
          ...(state.sessionId
            ? {
                resumeCursor: {
                  version: 1,
                  sessionId: state.sessionId,
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
        for (const [requestId, pending] of pendingUserInputs) {
          if (pending.turnId === turnId) {
            pendingUserInputs.delete(requestId);
            pending.resolve(null);
          }
        }
      }
    };

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: CLAUDE_AGENT_PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },

      startSession: (input: ProviderSessionStartInput) =>
        Effect.gen(function* () {
          const credential = resolveRuntimeCredential();
          if (!credential.ok) {
            return yield* Effect.fail(
              new ProviderAdapterValidationError({
                provider: CLAUDE_AGENT_PROVIDER,
                operation: "startSession",
                issue: credential.reason,
              }),
            );
          }
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
            sessionId: cursor?.sessionId,
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
          const credential = resolveRuntimeCredential();
          if (!credential.ok) {
            return yield* Effect.fail(
              new ProviderAdapterValidationError({
                provider: CLAUDE_AGENT_PROVIDER,
                operation: "sendTurn",
                issue: credential.reason,
              }),
            );
          }
          // Images go to Claude Code as base64 content blocks in a single streamed
          // user message. Without attachments the prompt stays a plain string.
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
              return {
                type: "image",
                source: { type: "base64", media_type: attachment.mimeType, data },
              };
            }),
          );
          const promptInput: string | AsyncIterable<SDKUserMessage> =
            imageBlocks.length === 0
              ? prompt
              : singleUserMessage([{ type: "text", text: prompt }, ...imageBlocks]);
          const authSessionId = yield* currentAuthSessionId;
          const mcp =
            state.workspaceContext === "none"
              ? undefined
              : McpProviderSession.readMcpProviderSession(
                  input.threadId,
                  options.instanceId,
                  authSessionId ?? undefined,
                );
          const customInstructions = options.getCustomInstructions
            ? yield* options.getCustomInstructions()
            : "";
          const instructions = [customInstructions, SPARKY_CLAUDE_AGENT_SKILL]
            .filter((part) => part.trim().length > 0)
            .join("\n\n");
          if (input.modelSelection?.model)
            state.session = { ...state.session, model: input.modelSelection.model };
          const turnId = TurnId.make(NodeCrypto.randomUUID());
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
            turnId,
            prompt: promptInput,
            environment: options.environment,
            mcp,
            instructions,
            runtimeMode: state.session.runtimeMode,
            apiKey: credential.apiKey,
            planMode: input.interactionMode === "plan",
            effort: resolveClaudeAgentEffort(input.modelSelection),
          });
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: state.sessionId
              ? ({ version: 1, sessionId: state.sessionId } satisfies ClaudeAgentResumeCursor)
              : undefined,
          } satisfies ProviderTurnStartResult;
        }),

      interruptTurn: (threadId) =>
        Effect.gen(function* () {
          const state = yield* requireSession(threadId);
          state.activeTurn?.abortController.abort();
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

      respondToUserInput: (threadId, requestId, answers: ProviderUserInputAnswers) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          const pending = pendingUserInputs.get(String(requestId));
          if (!pending || pending.threadId !== threadId) {
            return yield* Effect.fail(
              notSupported("respondToUserInput", `No pending question ${String(requestId)}.`),
            );
          }
          const normalized: Record<string, string> = {};
          for (const question of pending.questions) {
            const value = answers[question.id];
            const text = Array.isArray(value)
              ? value
                  .map((item) => String(item).trim())
                  .filter((item) => item.length > 0)
                  .join(", ")
              : typeof value === "string"
                ? value.trim()
                : "";
            if (text.length === 0) {
              return yield* Effect.fail(
                new ProviderAdapterValidationError({
                  provider: CLAUDE_AGENT_PROVIDER,
                  operation: "respondToUserInput",
                  issue: `Answer the question "${question.header}" before continuing.`,
                }),
              );
            }
            normalized[question.id] = text;
          }
          pending.resolve(normalized);
        }),

      stopSession: (threadId) =>
        Effect.gen(function* () {
          const state = sessions.get(threadId);
          if (!state) return;
          state.activeTurn?.abortController.abort();
          sessions.delete(threadId);
          for (const [requestId, pending] of pendingApprovals) {
            if (pending.threadId === threadId) {
              pendingApprovals.delete(requestId);
              pending.resolve("cancel");
            }
          }
          for (const [requestId, pending] of pendingUserInputs) {
            if (pending.threadId === threadId) {
              pendingUserInputs.delete(requestId);
              pending.resolve(null);
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
          for (const state of sessions.values()) state.activeTurn?.abortController.abort();
          sessions.clear();
          for (const [requestId, pending] of pendingApprovals) {
            pendingApprovals.delete(requestId);
            pending.resolve("cancel");
          }
          for (const [requestId, pending] of pendingUserInputs) {
            pendingUserInputs.delete(requestId);
            pending.resolve(null);
          }
        }),

      streamEvents: Stream.fromPubSub(runtimeEvents),
      subscribeEvents: PubSub.subscribe(runtimeEvents),
    };

    return adapter;
  });

function projectFreeCwd(attachmentsDir: string, threadId: ThreadId): string {
  return NodePath.join(attachmentsDir, "claude-agent", "projectless", String(threadId));
}
