import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  UNSCOPED_CHAT_PROJECT_ID,
  type ProjectId,
  type OrchestrationSession,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderWorkspaceContext,
  ThreadId,
  type RuntimeMode,
  type TurnId,
} from "@sparky/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@sparky/shared/git";
import { getModelSelectionStringOptionValue } from "@sparky/shared/model";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@sparky/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { sanitizeThreadTitle } from "../../textGeneration/TextGenerationUtils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  getModelSelectionContextWindowTokens,
  isAuthoritativeContextWindowSource,
  withModelSelectionContextWindow,
} from "../../provider/modelContextStability.ts";
import {
  isCodexOAuthModel,
  normalizeCodexOAuthEffectiveContextWindowTokens,
} from "../../provider/codexContextWindow.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

type ThreadTitleGenerationInput = {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly messageText: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly titleSeed?: string;
  readonly workspaceContext: ProviderWorkspaceContext;
  readonly modelSelection: ModelSelection;
};

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
const SPARKY_INSTANCE_ID = ProviderInstanceId.make("sparky");
const PROVIDER_CONTROL_TIMEOUT = Duration.seconds(5);

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const serverConfig = yield* ServerConfig;
  const textGeneration = yield* TextGeneration;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  /**
   * Interrupt and stop are UI control operations, not turn work. A provider
   * adapter that is waiting on a dead child process or an unresponsive RPC
   * must not be able to prevent the orchestration session from reaching a
   * terminal state. Preserve parent-fiber interruption, but turn provider
   * failures/timeouts into a detail that the caller can record before settling
   * the session.
   */
  const runProviderControl = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.exit(effect.pipe(Effect.timeout(PROVIDER_CONTROL_TIMEOUT))).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) {
          return Effect.succeed<string | null>(null);
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.failCause(exit.cause);
        }
        return Effect.succeed(formatFailureDetail(exit.cause));
      }),
    );

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const settleProviderControl = Effect.fnUntraced(function* (input: {
    readonly thread: OrchestrationThread;
    readonly status: "interrupted" | "stopped";
    readonly createdAt: string;
    readonly failureDetail: string | null;
    readonly activityKind: "provider.turn.interrupt.failed" | "provider.session.stop.failed";
    readonly activitySummary: string;
    readonly turnId: TurnId | null;
  }) {
    if (input.failureDetail !== null) {
      yield* appendProviderFailureActivity({
        threadId: input.thread.id,
        kind: input.activityKind,
        summary: input.activitySummary,
        detail: input.failureDetail,
        turnId: input.turnId,
        createdAt: input.createdAt,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to append provider control failure activity", {
            threadId: input.thread.id,
            activityKind: input.activityKind,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }

    if (input.thread.session === null) {
      return;
    }

    // This dispatch is the authoritative local terminal event. Provider
    // adapters may emit a later turn.completed event; the projector accepts
    // that idempotently after activeTurnId has been cleared.
    yield* setThreadSession({
      threadId: input.thread.id,
      session: {
        ...input.thread.session,
        status: input.status,
        activeTurnId: null,
        lastError: input.failureDetail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
    // Provider control can time out or race with already-buffered runtime
    // events. Finalize every projected assistant segment after publishing the
    // terminal session state so the composer and message tail stop
    // immediately, without waiting for a provider turn.completed event.
    const settledThread = yield* resolveThread(input.thread.id);
    const streamingAssistantMessages =
      settledThread?.messages.filter(
        (message) => message.role === "assistant" && message.streaming,
      ) ?? [];
    yield* Effect.forEach(
      streamingAssistantMessages,
      (message) =>
        serverCommandId("provider-control-assistant-complete").pipe(
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.message.assistant.complete",
              commandId,
              threadId: input.thread.id,
              messageId: message.id,
              ...(message.turnId !== null ? { turnId: message.turnId } : {}),
              createdAt: input.createdAt,
            }),
          ),
        ),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!session) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        status: session.status === "stopped" ? "stopped" : "ready",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const annotateModelSelectionContextSource = Effect.fnUntraced(function* (input: {
    readonly selection: ModelSelection;
    readonly thread: OrchestrationThread;
  }) {
    const rawSelection = input.selection;
    const selection = isCodexOAuthModel(rawSelection.model)
      ? (() => {
          const requested = getModelSelectionContextWindowTokens(rawSelection);
          const effective = normalizeCodexOAuthEffectiveContextWindowTokens(
            rawSelection.model,
            requested,
          );
          return effective === undefined
            ? rawSelection
            : withModelSelectionContextWindow(rawSelection, effective, "oauth");
        })()
      : rawSelection;
    if (isAuthoritativeContextWindowSource(selection.contextWindowSource)) {
      return selection;
    }

    // Preserve an already observed provider value when a refreshed UI
    // selection contains the same model/capacity but has no provenance. This
    // prevents a Models.dev refresh from downgrading a stable runtime value.
    const previous = input.thread.modelSelection;
    if (
      previous.instanceId === selection.instanceId &&
      previous.model === selection.model &&
      isAuthoritativeContextWindowSource(previous.contextWindowSource) &&
      getModelSelectionContextWindowTokens(previous) ===
        getModelSelectionContextWindowTokens(selection)
    ) {
      return {
        ...selection,
        ...(previous.contextWindowSource
          ? { contextWindowSource: previous.contextWindowSource }
          : {}),
      };
    }

    const providers = yield* providerRegistry.getProviders;
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    const model = provider?.models?.find((candidate) => candidate.slug === selection.model);
    return model?.contextWindowSource === undefined
      ? selection
      : { ...selection, contextWindowSource: model.contextWindowSource };
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const storedCurrentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const storedDesiredModelSelection = yield* annotateModelSelectionContextSource({
      selection: requestedModelSelection ?? thread.modelSelection,
      thread,
    });
    const resolveInstanceWithSparkyMigration = (storedInstanceId: ProviderInstanceId) =>
      providerService.getInstanceInfo(storedInstanceId).pipe(
        Effect.map((info) => ({ instanceId: storedInstanceId, info, migrated: false }) as const),
        Effect.catch((originalError) =>
          providerService.getInstanceInfo(SPARKY_INSTANCE_ID).pipe(
            Effect.map(
              (info) => ({ instanceId: SPARKY_INSTANCE_ID, info, migrated: true }) as const,
            ),
            Effect.mapError(() => originalError),
          ),
        ),
      );
    const currentResolution = yield* resolveInstanceWithSparkyMigration(
      storedCurrentInstanceId,
    ).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(storedCurrentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${storedCurrentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredResolution = yield* resolveInstanceWithSparkyMigration(
      storedDesiredModelSelection.instanceId,
    ).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(storedDesiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${storedDesiredModelSelection.instanceId}' is not configured in this build.`,
          }),
      ),
    );
    const currentInstanceId = currentResolution.instanceId;
    const currentInfo = currentResolution.info;
    const desiredInstanceId = desiredResolution.instanceId;
    const desiredInfo = desiredResolution.info;
    const desiredModelSelection: ModelSelection =
      desiredInstanceId === storedDesiredModelSelection.instanceId
        ? storedDesiredModelSelection
        : { ...storedDesiredModelSelection, instanceId: desiredInstanceId };
    if (currentResolution.migrated || desiredResolution.migrated) {
      yield* Effect.logInfo("migrating legacy provider instance to Sparky", {
        threadId,
        storedCurrentInstanceId,
        storedDesiredInstanceId: storedDesiredModelSelection.instanceId,
        effectiveInstanceId: SPARKY_INSTANCE_ID,
      });
    }
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const workspaceContext: ProviderWorkspaceContext =
      thread.projectId === UNSCOPED_CHAT_PROJECT_ID ? "none" : "project";
    const project =
      workspaceContext === "none" ? undefined : yield* resolveProject(thread.projectId);
    const effectiveCwd =
      workspaceContext === "none"
        ? undefined
        : resolveThreadWorkspaceCwd({
            thread,
            projects: project ? [project] : [],
          });

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        workspaceContext,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId && activeSession) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const activeWorkspaceContext: ProviderWorkspaceContext =
        activeSession.workspaceContext ??
        (workspaceContext === "none" && activeSession.cwd !== undefined
          ? "project"
          : workspaceContext);
      const workspaceContextChanged = activeWorkspaceContext !== workspaceContext;
      const cwdChanged = effectiveCwd !== activeSession.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = thread.modelSelection;
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);
      const shouldRestartForCodexContextWindowChange =
        preferredProvider === "codex" &&
        requestedModelSelection !== undefined &&
        previousModelSelection !== undefined &&
        getModelSelectionStringOptionValue(previousModelSelection, "contextWindow") !==
          getModelSelectionStringOptionValue(requestedModelSelection, "contextWindow");

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !workspaceContextChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange &&
        !shouldRestartForCodexContextWindowChange
      ) {
        return existingSessionThreadId;
      }

      const canResumeCursor = workspaceContext !== "none" || activeWorkspaceContext === "none";
      const resumeCursor =
        shouldRestartForModelChange || !canResumeCursor
          ? undefined
          : (activeSession.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        ...(workspaceContext === "none" ? {} : { previousCwd: activeSession.cwd }),
        ...(workspaceContext === "none" ? {} : { desiredCwd: effectiveCwd }),
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        shouldRestartForCodexContextWindowChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        ...(workspaceContext === "none" ? {} : { cwd: restartedSession.cwd }),
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const effectiveInputModelSelection =
      input.modelSelection !== undefined
        ? yield* annotateModelSelectionContextSource({
            selection: input.modelSelection,
            thread,
          })
        : undefined;
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const requestedModelSelection = effectiveInputModelSelection ?? thread.modelSelection;
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      modelSelection: requestedModelSelection,
    });
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : requestedModelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection: ModelSelection;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection: input.modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const applyFallbackThreadTitle = Effect.fn("applyFallbackThreadTitle")(function* (
    input: ThreadTitleGenerationInput,
  ) {
    const fallbackTitle = sanitizeThreadTitle(input.messageText);
    if (fallbackTitle === DEFAULT_THREAD_TITLE) return;

    const thread = yield* resolveThread(input.threadId);
    if (!thread) return;

    const canReplaceTitle = (currentTitle: string) =>
      canReplaceThreadTitle(currentTitle, input.titleSeed) || currentTitle.trim() === fallbackTitle;
    if (!canReplaceTitle(thread.title)) return;

    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield* serverCommandId("thread-title-fallback"),
      threadId: input.threadId,
      title: fallbackTitle,
    });
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: ThreadTitleGenerationInput) {
      const attachments = input.attachments ?? [];
      const fallbackTitle = sanitizeThreadTitle(input.messageText);
      const canReplaceTitle = (currentTitle: string) =>
        canReplaceThreadTitle(currentTitle, input.titleSeed) ||
        (fallbackTitle !== DEFAULT_THREAD_TITLE && currentTitle.trim() === fallbackTitle);

      yield* Effect.gen(function* () {
        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(input.workspaceContext === "none"
              ? { workspaceContext: input.workspaceContext }
              : {}),
            modelSelection: input.modelSelection,
          })
          .pipe(Effect.timeout(Duration.seconds(30)));

        const generatedTitle = sanitizeThreadTitle(generated.title);
        if (generatedTitle === DEFAULT_THREAD_TITLE) {
          yield* applyFallbackThreadTitle(input);
          return;
        }

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceTitle(thread.title)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generatedTitle,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              "provider command reactor failed to generate or rename thread title",
              {
                threadId: input.threadId,
                cwd: input.cwd,
                cause: Cause.pretty(cause),
              },
            );

            yield* applyFallbackThreadTitle(input).pipe(
              Effect.catchCause((fallbackCause) =>
                Effect.logWarning(
                  "provider command reactor failed to apply fallback thread title",
                  {
                    threadId: input.threadId,
                    cwd: input.cwd,
                    cause: Cause.pretty(fallbackCause),
                  },
                ),
              ),
            );
          }),
        ),
      );
    },
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    let generationInput: ThreadTitleGenerationInput | undefined;
    const workspaceContext: ProviderWorkspaceContext =
      thread.projectId === UNSCOPED_CHAT_PROJECT_ID ? "none" : "project";
    if (isFirstUserMessageTurn) {
      const project =
        workspaceContext === "none" ? undefined : yield* resolveProject(thread.projectId);
      const generationCwd =
        workspaceContext === "none"
          ? serverConfig.attachmentsDir
          : resolveThreadWorkspaceCwd({
              thread,
              projects: project ? [project] : [],
            });
      if (generationCwd === undefined) {
        yield* Effect.logWarning("skipping thread title generation without a workspace", {
          threadId: event.payload.threadId,
        });
      } else {
        generationInput = {
          threadId: event.payload.threadId,
          cwd: generationCwd,
          messageText: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
          workspaceContext,
          modelSelection: event.payload.modelSelection ?? thread.modelSelection,
        };
        if (workspaceContext === "project") {
          const firstTurnGenerationInput = generationInput;

          yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            ...firstTurnGenerationInput,
          }).pipe(Effect.forkScoped);
        }
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    const titleInput =
      generationInput !== undefined && canReplaceThreadTitle(thread.title, event.payload.titleSeed)
        ? generationInput
        : undefined;
    if (titleInput !== undefined) {
      // Put a deterministic local title in place immediately, then run title
      // generation as an independent text-only request using the exact model
      // selection. It can finish while the real turn is still streaming.
      yield* applyFallbackThreadTitle(titleInput).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "provider command reactor failed to apply immediate fallback thread title",
            {
              threadId: titleInput.threadId,
              cause: Cause.pretty(cause),
            },
          ),
        ),
      );
      yield* maybeGenerateThreadTitleForFirstTurn(titleInput).pipe(
        // Metadata generation must never hold the turn-start worker open.
        Effect.forkScoped,
        Effect.asVoid,
      );
    }

    const providerTurn = providerService
      .sendTurn(sendTurnRequest.value)
      .pipe(Effect.catchCause((cause) => recoverTurnStartFailure(cause)));

    yield* providerTurn.pipe(Effect.forkScoped);
  });

  // Keep the provider event subscription alive for adapters that use the
  // subscription as part of their runtime lifecycle. Title generation no
  // longer waits on these events, but the stream remains an adapter boundary.
  const processProviderRuntimeEvent = (_event: ProviderRuntimeEvent) => Effect.void;

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by
    // session. Always settle the local lifecycle even when the provider RPC
    // cannot return (for example, a dead app-server child).
    const turnId = event.payload.turnId ?? thread.session?.activeTurnId ?? null;
    yield* settleProviderControl({
      thread,
      status: "interrupted",
      createdAt: event.payload.createdAt,
      failureDetail: null,
      activityKind: "provider.turn.interrupt.failed",
      activitySummary: "Provider turn interrupt failed",
      turnId,
    }).pipe(Effect.forkDetach({ startImmediately: true }));
    yield* Effect.yieldNow;

    yield* runProviderControl(
      providerService.interruptTurn({ threadId: event.payload.threadId }),
    ).pipe(
      Effect.flatMap((failureDetail) =>
        failureDetail === null
          ? Effect.void
          : settleProviderControl({
              thread,
              status: "interrupted",
              createdAt: event.payload.createdAt,
              failureDetail,
              activityKind: "provider.turn.interrupt.failed",
              activitySummary: "Provider turn interrupt failed",
              turnId,
            }),
      ),
      Effect.catchCause(() => Effect.void),
      Effect.forkDetach({ startImmediately: true }),
    );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;

    if (thread.session) {
      const session = thread.session;
      yield* settleProviderControl({
        thread,
        status: "stopped",
        createdAt: now,
        failureDetail: null,
        activityKind: "provider.session.stop.failed",
        activitySummary: "Provider session stop failed",
        turnId: session.activeTurnId,
      }).pipe(Effect.forkDetach({ startImmediately: true }));

      if (session.status !== "stopped") {
        yield* runProviderControl(providerService.stopSession({ threadId: thread.id })).pipe(
          Effect.flatMap((failureDetail) =>
            failureDetail === null
              ? Effect.void
              : settleProviderControl({
                  thread,
                  status: "stopped",
                  createdAt: now,
                  failureDetail,
                  activityKind: "provider.session.stop.failed",
                  activitySummary: "Provider session stop failed",
                  turnId: session.activeTurnId,
                }),
          ),
          Effect.catchCause(() => Effect.void),
          Effect.forkDetach({ startImmediately: true }),
        );
      }
      return;
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: null,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
          modelSelection: thread.modelSelection,
        });
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
    const providerEvents = providerService.subscribeEvents
      ? Stream.fromSubscription(yield* providerService.subscribeEvents)
      : providerService.streamEvents;
    yield* Effect.forkScoped(Stream.runForEach(providerEvents, processProviderRuntimeEvent));
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
