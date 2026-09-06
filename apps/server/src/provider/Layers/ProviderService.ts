/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderWorkspaceContext,
} from "@sparky/contracts";
import { causeErrorTag } from "@sparky/shared/observability";
import { makeDrainableWorker } from "@sparky/shared/DrainableWorker";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";

import {
  increment,
  metricAttributes,
  providerMetricAttributes,
  providerFirstAssistantDeltaDuration,
  providerFirstRuntimeEventDuration,
  providerRuntimeEventProcessingDuration,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import { type ProviderAdapterError, ProviderValidationError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  parseContextWindowTokens,
  sameModelSelectionModel,
  withModelSelectionContextWindow,
} from "../modelContextStability.ts";
import {
  isCodexOAuthModel,
  normalizeCodexOAuthEffectiveContextWindowTokens,
} from "../codexContextWindow.ts";
const isModelSelection = Schema.is(ModelSelection);

interface PendingTurnLatency {
  readonly startedAt: bigint;
  readonly provider: string;
  readonly model: string | undefined;
  readonly sawRuntimeEvent: boolean;
  readonly sawAssistantDelta: boolean;
}

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly workspaceContext?: ProviderWorkspaceContext;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  const workspaceContext = extra?.workspaceContext ?? session.workspaceContext;
  return {
    ...(workspaceContext !== "none" && session.cwd !== undefined ? { cwd: session.cwd } : {}),
    ...(workspaceContext !== undefined ? { workspaceContext } : {}),
    model: session.model ?? null,
    ...(session.contextWindowTokens !== undefined
      ? { contextWindowTokens: session.contextWindowTokens }
      : {}),
    ...(session.contextWindowSource !== undefined
      ? { contextWindowSource: session.contextWindowSource }
      : {}),
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function isRuntimePayloadRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPersistedContextWindowTokens(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): number | undefined {
  if (!isRuntimePayloadRecord(runtimePayload)) return undefined;
  if (
    runtimePayload.contextWindowSource !== "provider" &&
    runtimePayload.contextWindowSource !== "oauth"
  ) {
    return undefined;
  }
  return parseContextWindowTokens(runtimePayload.contextWindowTokens);
}

function readPersistedContextWindowModel(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!isRuntimePayloadRecord(runtimePayload)) return undefined;
  const value = runtimePayload.contextWindowModel;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stabilizeModelSelectionWithPersistedContext(
  selection: ModelSelection | undefined,
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  const observedTokens = readPersistedContextWindowTokens(runtimePayload);
  if (observedTokens === undefined) return selection;

  const persistedSelection = readPersistedModelSelection(runtimePayload);
  const persistedSource = isRuntimePayloadRecord(runtimePayload)
    ? runtimePayload.contextWindowSource
    : undefined;
  const source = persistedSource === "oauth" ? "oauth" : "provider";
  const observedModel = readPersistedContextWindowModel(runtimePayload);
  const selectedModelMatchesPersisted = sameModelSelectionModel(selection, persistedSelection);
  const selectedModelMatchesObserved =
    selection !== undefined && observedModel !== undefined && selection.model === observedModel;

  if (selection !== undefined && (selectedModelMatchesPersisted || selectedModelMatchesObserved)) {
    return withModelSelectionContextWindow(selection, observedTokens, source);
  }

  if (selection === undefined && persistedSelection !== undefined) {
    return withModelSelectionContextWindow(persistedSelection, observedTokens, source);
  }

  return selection;
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedWorkspaceContext(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ProviderWorkspaceContext | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const value = "workspaceContext" in runtimePayload ? runtimePayload.workspaceContext : undefined;
  return value === "project" || value === "none" ? value : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const pendingTurnLatencies = yield* Ref.make(new Map<ThreadId, PendingTurnLatency>());
  const canonicalEventLogWorker = canonicalEventLogger
    ? yield* makeDrainableWorker(
        (input: { readonly event: ProviderRuntimeEvent; readonly threadId: ThreadId }) =>
          canonicalEventLogger.write(input.event, input.threadId),
      )
    : undefined;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    // Clear first so an issuance failure cannot fall back to an expired token
    // left by a previous registry or provider session.
    Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)).pipe(
      Effect.andThen(McpSessionRegistry.issueActiveMcpCredential({ threadId, providerInstanceId })),
      Effect.tap((credential) =>
        Effect.sync(() => {
          if (credential) {
            McpProviderSession.setMcpProviderSession(credential.config);
          }
        }),
      ),
    );
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    // Publish first. Logging is diagnostic side work handled by a drainable
    // queue, so a slow filesystem sink cannot add back-pressure to deltas.
    Effect.succeed(event).pipe(
      Effect.flatMap((canonicalEvent) =>
        PubSub.publish(runtimeEventPubSub, canonicalEvent).pipe(Effect.map(() => canonicalEvent)),
      ),
      Effect.tap((canonicalEvent) =>
        canonicalEventLogWorker
          ? canonicalEventLogWorker.enqueue({
              event: canonicalEvent,
              threadId: canonicalEvent.threadId,
            })
          : Effect.void,
      ),
      Effect.asVoid,
    );

  const observeTurnLatency = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const current = yield* Ref.get(pendingTurnLatencies);
      const pending = current.get(event.threadId);
      if (!pending) return;

      const now = yield* Clock.currentTimeNanos;
      const elapsed = Duration.nanos(now > pending.startedAt ? now - pending.startedAt : 0n);
      const attributes = providerMetricAttributes(event.provider, {
        ...(pending.model ? { model: pending.model } : {}),
        eventType: event.type,
      });
      const metricUpdates: Array<Effect.Effect<void>> = [];
      const sawAssistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text";
      if (!pending.sawRuntimeEvent) {
        metricUpdates.push(
          Metric.update(
            Metric.withAttributes(providerFirstRuntimeEventDuration, metricAttributes(attributes)),
            elapsed,
          ),
        );
      }
      if (!pending.sawAssistantDelta && sawAssistantDelta) {
        metricUpdates.push(
          Metric.update(
            Metric.withAttributes(
              providerFirstAssistantDeltaDuration,
              metricAttributes(attributes),
            ),
            elapsed,
          ),
        );
      }

      if (metricUpdates.length > 0) {
        yield* Effect.forEach(metricUpdates, (update) => update, { discard: true });
      }
      yield* Ref.set(
        pendingTurnLatencies,
        new Map(current).set(event.threadId, {
          ...pending,
          sawRuntimeEvent: true,
          sawAssistantDelta: pending.sawAssistantDelta || sawAssistantDelta,
        }),
      );
    });

  const clearTurnLatency = (threadId: ThreadId): Effect.Effect<void> =>
    Ref.update(pendingTurnLatencies, (current) => {
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly workspaceContext?: ProviderWorkspaceContext;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const persistRuntimeEventState = (
    canonicalEvent: ProviderRuntimeEvent,
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const binding = Option.getOrUndefined(yield* directory.getBinding(canonicalEvent.threadId));
      if (!binding) return;

      const runtimePayload: Record<string, unknown> = {
        lastRuntimeEvent: canonicalEvent.type,
        lastRuntimeEventAt: canonicalEvent.createdAt,
      };
      let status: "running" | "stopped" | "error" | undefined;

      if (canonicalEvent.type === "thread.token-usage.updated") {
        const observedContextWindow = canonicalEvent.payload.usage.maxTokens;
        if (observedContextWindow !== undefined && observedContextWindow > 0) {
          const persistedSelection = readPersistedModelSelection(binding.runtimePayload);
          const selectedModel = persistedSelection?.model;
          const oauthContext =
            isCodexOAuthModel(selectedModel) ||
            (isRuntimePayloadRecord(binding.runtimePayload) &&
              binding.runtimePayload.contextWindowSource === "oauth");
          const effectiveContextWindow = oauthContext
            ? (normalizeCodexOAuthEffectiveContextWindowTokens(
                selectedModel,
                observedContextWindow,
              ) ?? observedContextWindow)
            : observedContextWindow;
          const contextSource = oauthContext ? "oauth" : "provider";
          const stabilizedSelection = persistedSelection
            ? withModelSelectionContextWindow(
                persistedSelection,
                effectiveContextWindow,
                contextSource,
              )
            : undefined;
          runtimePayload.contextWindowTokens = effectiveContextWindow;
          runtimePayload.contextWindowSource = contextSource;
          if (selectedModel !== undefined) runtimePayload.contextWindowModel = selectedModel;
          if (stabilizedSelection !== undefined) {
            runtimePayload.modelSelection = stabilizedSelection;
          }
        }
      }

      if (canonicalEvent.type === "turn.completed") {
        runtimePayload.activeTurnId = null;
        // The directory status describes the provider session (which stays
        // reusable for the next turn), while `activeTurnId` is the terminal
        // task-state marker. Keep a healthy session routable after a turn
        // completes so the inactivity reaper does not mistake it for an
        // explicitly stopped session.
        status = canonicalEvent.payload.state === "failed" ? "error" : "running";
        runtimePayload.lastError =
          canonicalEvent.payload.state === "failed"
            ? (canonicalEvent.payload.errorMessage ?? "Turn failed")
            : null;
        const resumeCursor = canonicalEvent.payload.resumeCursor;
        if (resumeCursor !== undefined) {
          yield* directory.upsert({
            threadId: canonicalEvent.threadId,
            provider: canonicalEvent.provider,
            providerInstanceId: source.instanceId,
            status,
            resumeCursor,
            runtimePayload,
          });
          return;
        }
      } else if (canonicalEvent.type === "turn.aborted") {
        runtimePayload.activeTurnId = null;
        // Aborting a turn leaves the provider session reusable. The task is
        // terminal through activeTurnId; the directory status remains a
        // healthy provider-session marker for the next turn.
        status = "running";
        runtimePayload.lastError = null;
      } else if (canonicalEvent.type === "session.exited") {
        runtimePayload.activeTurnId = null;
        status = "stopped";
      } else if (canonicalEvent.type === "runtime.error") {
        runtimePayload.activeTurnId = null;
        runtimePayload.lastError = canonicalEvent.payload.message;
        status = "error";
      }

      if (Object.keys(runtimePayload).length <= 2 && status === undefined) return;
      yield* directory.upsert({
        threadId: canonicalEvent.threadId,
        provider: canonicalEvent.provider,
        providerInstanceId: source.instanceId,
        ...(status !== undefined ? { status } : {}),
        runtimePayload,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to persist provider runtime state", {
          threadId: canonicalEvent.threadId,
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
          cause: error,
        }),
      ),
    );

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.flatMap(
      Effect.sync(() => correlateRuntimeEventWithInstance(source, event)),
      (canonicalEvent) =>
        observeTurnLatency(canonicalEvent).pipe(
          Effect.andThen(
            increment(providerRuntimeEventsTotal, {
              provider: canonicalEvent.provider,
              eventType: canonicalEvent.type,
            }),
          ),
          // Publish before the persistence side effect. A slow SQLite write
          // must not hold back the first delta or the terminal lifecycle event.
          Effect.andThen(publishRuntimeEvent(canonicalEvent)),
          Effect.andThen(persistRuntimeEventState(canonicalEvent, source)),
          Effect.andThen(
            canonicalEvent.type === "turn.completed" ||
              canonicalEvent.type === "turn.aborted" ||
              canonicalEvent.type === "runtime.error" ||
              canonicalEvent.type === "session.exited"
              ? clearTurnLatency(canonicalEvent.threadId)
              : Effect.void,
          ),
        ),
    ).pipe(
      withMetrics({
        timer: providerRuntimeEventProcessingDuration,
        attributes: {
          provider: source.provider,
          eventType: event.type,
        },
      }),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        const eventStream = adapter.subscribeEvents
          ? Stream.fromSubscription(yield* adapter.subscribeEvents)
          : adapter.streamEvents;
        yield* Stream.runForEach(eventStream, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ).pipe(
            // A malformed event must be diagnosed without terminating the
            // adapter's entire stream. Terminal cleanup is handled by the
            // event-specific path; later events must still be deliverable.
            Effect.catchCause((cause) =>
              Effect.logError("provider runtime event processing failed", {
                provider: adapter.provider,
                providerInstanceId: id,
                eventType: event.type,
                errorTag: causeErrorTag(cause),
              }),
            ),
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedWorkspaceContext = readPersistedWorkspaceContext(input.binding.runtimePayload);
      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = stabilizeModelSelectionWithPersistedContext(
        readPersistedModelSelection(input.binding.runtimePayload),
        input.binding.runtimePayload,
      );

      if (persistedWorkspaceContext !== "none") {
        yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);
      }
      const resumed = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedWorkspaceContext ? { workspaceContext: persistedWorkspaceContext } : {}),
          ...(persistedCwd && persistedWorkspaceContext !== "none" ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        })
        .pipe(
          Effect.onError(() =>
            persistedWorkspaceContext === "none"
              ? Effect.void
              : clearMcpSession(input.binding.threadId),
          ),
        );
      if (resumed.provider !== adapter.provider) {
        if (persistedWorkspaceContext !== "none") {
          yield* clearMcpSession(input.binding.threadId);
        }
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: bindingInstanceId },
        input.binding.threadId,
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const persistedWorkspaceContext = readPersistedWorkspaceContext(binding.runtimePayload);
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
        workspaceContext: persistedWorkspaceContext,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
        workspaceContext: persistedWorkspaceContext,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      isActive: true,
      workspaceContext: persistedWorkspaceContext,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in Sparky settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const persistedBindingMatchesInstance =
          persistedBinding?.providerInstanceId === resolvedInstanceId;
        const effectiveModelSelection = stabilizeModelSelectionWithPersistedContext(
          input.modelSelection ??
            (persistedBindingMatchesInstance
              ? readPersistedModelSelection(persistedBinding?.runtimePayload)
              : undefined),
          persistedBindingMatchesInstance ? persistedBinding?.runtimePayload : undefined,
        );
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);
        const persistedWorkspaceContext = persistedBindingMatchesInstance
          ? readPersistedWorkspaceContext(persistedBinding?.runtimePayload)
          : undefined;
        const effectiveWorkspaceContext: ProviderWorkspaceContext =
          input.workspaceContext ?? persistedWorkspaceContext ?? "project";
        const effectiveCwd =
          effectiveWorkspaceContext === "none"
            ? undefined
            : (input.cwd ??
              (persistedBinding?.providerInstanceId === resolvedInstanceId
                ? readPersistedCwd(persistedBinding.runtimePayload)
                : undefined));
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        if (effectiveWorkspaceContext !== "none") {
          yield* prepareMcpSession(threadId, resolvedInstanceId);
        }
        const session = yield* adapter
          .startSession({
            ...input,
            providerInstanceId: resolvedInstanceId,
            ...(effectiveModelSelection !== undefined
              ? { modelSelection: effectiveModelSelection }
              : {}),
            ...(effectiveWorkspaceContext !== undefined
              ? { workspaceContext: effectiveWorkspaceContext }
              : {}),
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(
            Effect.onError(() =>
              effectiveWorkspaceContext === "none" ? Effect.void : clearMcpSession(threadId),
            ),
          );

        if (session.provider !== adapter.provider) {
          if (effectiveWorkspaceContext !== "none") {
            yield* clearMcpSession(threadId);
          }
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: effectiveModelSelection,
          workspaceContext: effectiveWorkspaceContext,
        });
        yield* analytics.record("provider.session.started", {
          provider: sessionWithInstance.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof effectiveModelSelection?.model === "string" &&
            effectiveModelSelection.model.trim().length > 0,
        });

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      const bindingMatchesInstance = binding?.providerInstanceId === routed.instanceId;
      const effectiveModelSelection = stabilizeModelSelectionWithPersistedContext(
        input.modelSelection ??
          (bindingMatchesInstance
            ? readPersistedModelSelection(binding?.runtimePayload)
            : undefined),
        bindingMatchesInstance ? binding?.runtimePayload : undefined,
      );
      const effectiveInput = {
        ...input,
        ...(effectiveModelSelection !== undefined
          ? { modelSelection: effectiveModelSelection }
          : {}),
      };
      metricModel = effectiveModelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(effectiveModelSelection?.model
          ? { "provider.model": effectiveModelSelection.model }
          : {}),
      });
      // Sparky launches one short-lived MCP client per turn. Refresh its
      // provider-scoped credential immediately before launch so an idle or
      // restarted MCP registry cannot leave the child with an expired token.
      if (String(routed.adapter.provider) === "sparky") {
        yield* prepareMcpSession(input.threadId, routed.instanceId);
      }
      const turnStartedAt = yield* Clock.currentTimeNanos;
      yield* Ref.update(pendingTurnLatencies, (current) => {
        const next = new Map(current);
        next.set(input.threadId, {
          startedAt: turnStartedAt,
          provider: String(routed.adapter.provider),
          model: effectiveModelSelection?.model,
          sawRuntimeEvent: false,
          sawAssistantDelta: false,
        });
        return next;
      });
      const turn = yield* routed.adapter
        .sendTurn(effectiveInput)
        .pipe(
          Effect.catchCause((cause) =>
            clearTurnLatency(input.threadId).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(effectiveModelSelection !== undefined
            ? { modelSelection: effectiveModelSelection }
            : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: effectiveModelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          // Interrupt is a local control operation. Never start a new provider
          // session just to interrupt a turn whose in-memory session vanished.
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        if (routed.isActive) {
          yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        }
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
          providerSessionActive: routed.isActive,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        if (routed.workspaceContext !== "none") {
          yield* clearMcpSession(input.threadId);
        }
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  // `runStopAll` is registered after this finalizer, so it runs first during
  // shutdown. Once provider streams are stopped, the canonical log queue can
  // drain deterministically before its writer is closed.
  yield* Effect.addFinalizer(() => canonicalEventLogWorker?.drain ?? Effect.void);

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    subscribeEvents: PubSub.subscribe(runtimeEventPubSub),
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
