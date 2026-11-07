import { estimateModelApiCostUsd } from "./modelApiPricing";

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
  | "provider"
  | "model"
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "reasoningOutputTokens"
  | "totalTokens"
  | "occurredAt"
> & { readonly costUsd?: number | undefined };

const LOCAL_USAGE_KEY = "sparky:local-model-analytics:v1";
const MAX_LOCAL_EVENTS = 5_000;
const recentEventIds = new Set<string>();

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizeLocalEvent(value: unknown): LocalModelUsageEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Record<string, unknown>;
  if (
    typeof event.provider !== "string" ||
    typeof event.model !== "string" ||
    typeof event.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(event.occurredAt))
  ) {
    return undefined;
  }
  const inputTokens = optionalNumber(event.inputTokens);
  const cachedInputTokens = optionalNumber(event.cachedInputTokens);
  const outputTokens = optionalNumber(event.outputTokens);
  const reasoningOutputTokens = optionalNumber(event.reasoningOutputTokens);
  const totalTokens = optionalNumber(event.totalTokens);
  const storedCostUsd = optionalNumber(event.costUsd);
  const costUsd =
    storedCostUsd ??
    estimateModelApiCostUsd(event.model, {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    });
  return {
    provider: event.provider,
    model: event.model,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    occurredAt: event.occurredAt,
  };
}

export function readLocalModelAnalyticsEvents(): ReadonlyArray<LocalModelUsageEvent> {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_USAGE_KEY) ?? "[]";
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return [];
    const events = stored
      .map(sanitizeLocalEvent)
      .filter((event): event is LocalModelUsageEvent => event !== undefined);
    // Rewrite legacy rows so old persisted event IDs are removed as soon as read.
    const sanitized = JSON.stringify(events);
    if (sanitized !== raw) window.localStorage.setItem(LOCAL_USAGE_KEY, sanitized);
    return events;
  } catch {
    return [];
  }
}

function storeLocalModelAnalyticsEvent(event: ModelAnalyticsEvent): void {
  if (typeof window === "undefined" || recentEventIds.has(event.eventId)) return;
  try {
    const costUsd = estimateModelApiCostUsd(event.model, event);
    const savedEvent: LocalModelUsageEvent = {
      provider: event.provider,
      model: event.model,
      ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
      ...(event.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: event.cachedInputTokens }),
      ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
      ...(event.reasoningOutputTokens === undefined
        ? {}
        : { reasoningOutputTokens: event.reasoningOutputTokens }),
      ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
      ...(costUsd === undefined ? {} : { costUsd }),
      occurredAt: event.occurredAt,
    };
    const events = [...readLocalModelAnalyticsEvents()];
    events.push(savedEvent);
    window.localStorage.setItem(LOCAL_USAGE_KEY, JSON.stringify(events.slice(-MAX_LOCAL_EVENTS)));
    recentEventIds.add(event.eventId);
    if (recentEventIds.size > MAX_LOCAL_EVENTS) {
      const oldestEventId = recentEventIds.values().next().value;
      if (oldestEventId !== undefined) recentEventIds.delete(oldestEventId);
    }
  } catch {
    // Analytics are best-effort when browser storage is unavailable or full.
  }
}

/**
 * Records model metadata only in this browser; prompts, responses, IDs, and tool payloads are
 * excluded.
 */
export function recordModelAnalyticsEvent(event: ModelAnalyticsEvent): void {
  storeLocalModelAnalyticsEvent(event);
}
