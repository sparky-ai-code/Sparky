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
  readonly model?: unknown;
  readonly provider?: unknown;
};

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usagesForTurn(
  thread: OrchestrationThread,
  turnId: string,
): ReadonlyArray<{ model: string; provider: string; usage: NumericUsage; requests: number }> {
  const groups = new Map<string, { model: string; provider: string; usage: Record<string, number>; requests: number }>();
  for (const activity of thread.activities) {
    if (activity.turnId !== turnId || activity.kind !== "context-window.updated") continue;
    if (typeof activity.payload !== "object" || activity.payload === null) continue;
    const usage = activity.payload as NumericUsage;
    const model = typeof usage.model === "string" && usage.model.trim()
      ? usage.model
      : thread.modelSelection.model;
    const provider = typeof usage.provider === "string" && usage.provider.trim()
      ? usage.provider
      : String(thread.modelSelection.instanceId);
    const key = `${provider}\u0000${model}`;
    const group = groups.get(key) ?? { model, provider, usage: {}, requests: 0 };
    group.requests += 1;
    for (const field of [
      "lastInputTokens", "lastCachedInputTokens", "lastOutputTokens",
      "lastReasoningOutputTokens", "lastUsedTokens", "toolUses",
    ] as const) {
      const value = numeric(usage[field]);
      if (value !== undefined) group.usage[field] = (group.usage[field] ?? 0) + value;
    }
    groups.set(key, group);
  }
  if (groups.size === 0) {
    return [{ model: thread.modelSelection.model, provider: String(thread.modelSelection.instanceId), usage: {}, requests: 1 }];
  }
  return [...groups.values()].map(({ model, provider, usage, requests }) => ({
    model, provider, usage: usage as NumericUsage, requests,
  }));
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
  const usages = usagesForTurn(input.thread, turnId);
  const modelEvents = usages.map(({ model, provider, usage }, index) => {
    const totalTokens = numeric(usage.lastUsedTokens) ??
      (numeric(usage.lastInputTokens) ?? 0) +
      (numeric(usage.lastCachedInputTokens) ?? 0) +
      (numeric(usage.lastOutputTokens) ?? 0) +
      (numeric(usage.lastReasoningOutputTokens) ?? 0);
    const eventId = `turn:${threadId}:${turnId}:${encodeURIComponent(provider)}:${encodeURIComponent(model)}:${index}`;
    const event = {
      eventId,
      environmentId: input.environmentId,
      threadId,
      turnId,
      provider,
      providerInstanceId: provider,
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
    return { event, model, provider, requests: usages[index]?.requests ?? 1 };
  });

  const analyticsEvents = [
    recordPluginAnalyticsEvent({ type: "prompt", eventId: `prompt:${threadId}:${turnId}` }),
    ...modelEvents.flatMap(({ event, model, provider, requests }) => [
      recordPluginAnalyticsEvent({
        type: "model_call",
        eventId: `model-call:${event.eventId}`,
        model,
        provider,
      }),
      ...Array.from({ length: requests }, (_, index) => recordPluginAnalyticsEvent({
        type: "model_request",
        eventId: `model-request:${event.eventId}:${index}`,
        model,
        provider,
      })),
    ]),
    recordPluginAnalyticsEvent({
      type: "agent_call",
      eventId: `agent-call:${threadId}:${turnId}`,
      model: input.thread.modelSelection.model,
      provider: String(input.thread.modelSelection.instanceId),
    }),
  ];
  void Promise.allSettled(analyticsEvents);

  const results = await Promise.all(modelEvents.map(({ event }) => recordAccountUsageEvent(event)));
  return results.some(Boolean);
}
