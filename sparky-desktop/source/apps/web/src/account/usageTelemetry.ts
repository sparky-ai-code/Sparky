import type { OrchestrationThread } from "@sparky/contracts";

import { recordPluginAnalyticsEvent } from "../components/plugins/pluginApi";
import { recordAccountUsageEvent } from "./accountApi";
import { recordModelAnalyticsEvent } from "./modelAnalytics";

type NumericUsage = {
  readonly inputTokens?: unknown;
  readonly cachedInputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly reasoningOutputTokens?: unknown;
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
  const updates = thread.activities.filter(
    (candidate) => candidate.turnId === turnId && candidate.kind === "context-window.updated",
  );
  if (updates.length === 0) return {};

  const sum = (key: keyof NumericUsage, alternate?: keyof NumericUsage) => {
    let total = 0;
    let found = false;
    for (const activity of updates) {
      if (typeof activity.payload !== "object" || activity.payload === null) continue;
      const payload = activity.payload as NumericUsage;
      const value = numeric(payload[key]) ?? (alternate ? numeric(payload[alternate]) : undefined);
      if (value !== undefined) {
        total += value;
        found = true;
      }
    }
    return found ? total : undefined;
  };

  const latestPayload = updates[updates.length - 1]?.payload;
  const latestToolUses =
    typeof latestPayload === "object" && latestPayload !== null
      ? numeric((latestPayload as NumericUsage).toolUses)
      : undefined;

  return {
    lastInputTokens: sum("lastInputTokens", "inputTokens"),
    lastCachedInputTokens: sum("lastCachedInputTokens", "cachedInputTokens"),
    lastOutputTokens: sum("lastOutputTokens", "outputTokens"),
    lastReasoningOutputTokens: sum("lastReasoningOutputTokens", "reasoningOutputTokens"),
    lastUsedTokens:
      sum("lastUsedTokens") ??
      (sum("lastInputTokens", "inputTokens") ?? 0) +
        (sum("lastCachedInputTokens", "cachedInputTokens") ?? 0) +
        (sum("lastOutputTokens", "outputTokens") ?? 0) +
        (sum("lastReasoningOutputTokens", "reasoningOutputTokens") ?? 0),
    toolUses: latestToolUses,
  };
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
