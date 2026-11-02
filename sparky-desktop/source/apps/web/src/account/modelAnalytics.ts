export type ModelAnalyticsEvent = {
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

export type LocalModelUsageEvent = Pick<
  ModelAnalyticsEvent,
  "eventId" | "provider" | "model" | "totalTokens" | "costUsd" | "occurredAt"
>;

const LOCAL_USAGE_KEY = "sparky:local-model-analytics:v1";
const MAX_LOCAL_EVENTS = 5_000;

export function readLocalModelAnalyticsEvents(): ReadonlyArray<LocalModelUsageEvent> {
  if (typeof window === "undefined") return [];
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(LOCAL_USAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((value): value is LocalModelUsageEvent => {
      if (typeof value !== "object" || value === null) return false;
      const event = value as Record<string, unknown>;
      return (
        typeof event.eventId === "string" &&
        typeof event.provider === "string" &&
        typeof event.model === "string" &&
        typeof event.occurredAt === "string" &&
        Number.isFinite(Date.parse(event.occurredAt))
      );
    });
  } catch {
    return [];
  }
}

function storeLocalModelAnalyticsEvent(event: ModelAnalyticsEvent): void {
  if (typeof window === "undefined") return;
  try {
    const events = readLocalModelAnalyticsEvents().filter(
      (saved) => saved.eventId !== event.eventId,
    );
    events.push({
      eventId: event.eventId,
      provider: event.provider,
      model: event.model,
      totalTokens: event.totalTokens,
      costUsd: event.costUsd,
      occurredAt: event.occurredAt,
    });
    window.localStorage.setItem(LOCAL_USAGE_KEY, JSON.stringify(events.slice(-MAX_LOCAL_EVENTS)));
  } catch {
    // Analytics are best-effort when browser storage is unavailable or full.
  }
}

/** Records model metadata only in this browser; prompts, responses, and tool payloads are excluded. */
export function recordModelAnalyticsEvent(event: ModelAnalyticsEvent): void {
  storeLocalModelAnalyticsEvent(event);
}
