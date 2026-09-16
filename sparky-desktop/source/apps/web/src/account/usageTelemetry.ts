import type { OrchestrationThread } from "@sparky/contracts";

import { recordPluginAnalyticsEvent } from "../components/plugins/pluginApi";
import { recordAccountUsageEvent } from "./accountApi";
import { recordModelAnalyticsEvent } from "./modelAnalytics";

type NumericUsage = {
  readonly lastInputTokens?: unknown;
  readonly lastCachedInputTokens?: unknown;
  readonly lastOutputTokens?: unknown;
  readonly lastReasoningOutputTokens?: unknown;
  readonly lastUsedTokens?: unknown;
  readonly toolUses?: unknown;
};

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageForTurn(thread: OrchestrationThread, turnId: string): NumericUsage {
  const activity = [...thread.activities]
    .reverse()
    .find(
      (candidate) => candidate.turnId === turnId && candidate.kind === "context-window.updated",
    );
  if (!activity || typeof activity.payload !== "object" || activity.payload === null) return {};
  return activity.payload as NumericUsage;
}

function modelRequestCountForTurn(thread: OrchestrationThread, turnId: string): number {
  // Each context-window update is emitted by the provider request loop. Counting
  // those events captures multi-request tool/reasoning turns instead of assuming
  // one model request per submitted prompt. A settled provider turn still implies
  // at least one request even when an older harness omitted the activity event.
  return Math.max(
    1,
    thread.activities.filter(
      (candidate) => candidate.turnId === turnId && candidate.kind === "context-window.updated",
    ).length,
  );
}

/**
 * Records one idempotent usage row after a provider turn settles. Prompts,
 * responses, and tool payloads are deliberately excluded; only operational
 * usage metadata is sent to authenticated analytics endpoints.
 */
export async function recordCompletedTurnUsage(input: {
  readonly environmentId: string;
  readonly thread: OrchestrationThread;
}): Promise<boolean> {
  const turn = input.thread.latestTurn;
  if (turn === null || turn.state === "running") return false;

  const threadId = String(input.thread.id);
  const turnId = String(turn.turnId);
  const usage = usageForTurn(input.thread, turnId);
  const totalTokens =
    numeric(usage.lastUsedTokens) ??
    (numeric(usage.lastInputTokens) ?? 0) +
      (numeric(usage.lastCachedInputTokens) ?? 0) +
      (numeric(usage.lastOutputTokens) ?? 0) +
      (numeric(usage.lastReasoningOutputTokens) ?? 0);
  const providerInstanceId = String(input.thread.modelSelection.instanceId);
  const model = input.thread.modelSelection.model;

  const event = {
    eventId: `turn:${threadId}:${turnId}`,
    environmentId: input.environmentId,
    threadId,
    turnId,
    provider: providerInstanceId,
    providerInstanceId,
    model,
    inputTokens: numeric(usage.lastInputTokens),
    cachedInputTokens: numeric(usage.lastCachedInputTokens),
    outputTokens: numeric(usage.lastOutputTokens),
    reasoningOutputTokens: numeric(usage.lastReasoningOutputTokens),
    totalTokens,
    toolUses: numeric(usage.toolUses),
    occurredAt: turn.completedAt ?? input.thread.updatedAt,
  };
  recordModelAnalyticsEvent(event);

  const analyticsEvents = [
    recordPluginAnalyticsEvent({
      type: "prompt",
      eventId: `prompt:${threadId}:${turnId}`,
    }),
    recordPluginAnalyticsEvent({
      type: "model_call",
      eventId: `model-call:${threadId}:${turnId}`,
      model,
      provider: providerInstanceId,
    }),
    recordPluginAnalyticsEvent({
      type: "agent_call",
      eventId: `agent-call:${threadId}:${turnId}`,
      model,
      provider: providerInstanceId,
    }),
    ...Array.from({ length: modelRequestCountForTurn(input.thread, turnId) }, (_, index) =>
      recordPluginAnalyticsEvent({
        type: "model_request",
        eventId: `model-request:${threadId}:${turnId}:${index}`,
        model,
        provider: providerInstanceId,
      }),
    ),
  ];
  void Promise.allSettled(analyticsEvents);

  return recordAccountUsageEvent(event);
}
