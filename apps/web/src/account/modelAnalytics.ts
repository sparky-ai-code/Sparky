import { randomUUID } from "../lib/utils";

type ModelAnalyticsEvent = {
  readonly eventId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningOutputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly toolUses?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly occurredAt: string;
};

const analyticsEndpoint = import.meta.env.VITE_SPARKY_ANALYTICS_ENDPOINT?.trim() || null;

function idForStorage(storage: Storage, key: string): string {
  try {
    const current = storage.getItem(key);
    if (current) return current;
    const created = randomUUID();
    storage.setItem(key, created);
    return created;
  } catch {
    return randomUUID();
  }
}

function appAnalyticsContext() {
  if (typeof window === "undefined") return null;
  return {
    visitorId: idForStorage(window.localStorage, "sparky:app-analytics-visitor-id"),
    sessionId: idForStorage(window.sessionStorage, "sparky:app-analytics-session-id"),
  };
}

/** Sends model metadata only; prompts, responses, and tool payloads never leave the app. */
export function recordModelAnalyticsEvent(event: ModelAnalyticsEvent): void {
  if (analyticsEndpoint === null) return;
  const context = appAnalyticsContext();
  if (context === null) return;

  void fetch(analyticsEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    keepalive: true,
    body: JSON.stringify({
      source: "app",
      kind: "model_request",
      path: "/app/model-request",
      at: Date.parse(event.occurredAt) || Date.now(),
      requestId: event.eventId,
      visitorId: context.visitorId,
      sessionId: context.sessionId,
      platform: event.provider,
      label: event.model,
      model: event.model,
      provider: event.provider,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      reasoningOutputTokens: event.reasoningOutputTokens,
      totalTokens: event.totalTokens,
      toolUses: event.toolUses,
      costUsd: event.costUsd,
      outcome: "completed",
      environmentId: event.environmentId,
      threadId: event.threadId,
      turnId: event.turnId,
    }),
  }).catch(() => undefined);
}
