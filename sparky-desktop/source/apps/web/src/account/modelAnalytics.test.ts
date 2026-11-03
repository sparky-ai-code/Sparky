import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { estimateModelApiCostUsd } from "./modelApiPricing";
import { readLocalModelAnalyticsEvents, recordModelAnalyticsEvent } from "./modelAnalytics";

const LOCAL_USAGE_KEY = "sparky:local-model-analytics:v1";
const values = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
};

const fetchSpy = vi.fn();

beforeEach(() => {
  values.clear();
  fetchSpy.mockClear();
  vi.stubGlobal("window", { localStorage: localStorageStub });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local model analytics", () => {
  it("stores only chart metadata, estimates published API pricing, and deduplicates events", () => {
    const event = {
      eventId: "turn:private-thread:turn-1",
      environmentId: "private-environment",
      threadId: "private-thread",
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5.6-sol",
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      totalTokens: 150,
      occurredAt: "2026-01-12T10:00:00.000Z",
    };

    recordModelAnalyticsEvent(event);
    recordModelAnalyticsEvent(event);

    expect(readLocalModelAnalyticsEvents()).toEqual([
      {
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
        totalTokens: event.totalTokens,
        costUsd: 0.00141,
        occurredAt: event.occurredAt,
      },
    ]);
    expect(values.get(LOCAL_USAGE_KEY)).not.toContain("private-environment");
    expect(values.get(LOCAL_USAGE_KEY)).not.toContain("private-thread");
    expect(values.get(LOCAL_USAGE_KEY)).not.toContain("turn-1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("applies separate Anthropic cache-read pricing", () => {
    expect(
      estimateModelApiCostUsd("claude-sonnet-4-6", {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30,
      }),
    ).toBeCloseTo(0.000816);
  });

  it("does not invent a price for unsupported models or missing token breakdowns", () => {
    const event = {
      eventId: "turn:private-thread:turn-2",
      environmentId: "private-environment",
      threadId: "private-thread",
      turnId: "turn-2",
      provider: "cursor",
      model: "custom-model",
      totalTokens: 150,
      occurredAt: "2026-01-12T10:00:00.000Z",
    };

    recordModelAnalyticsEvent(event);
    recordModelAnalyticsEvent({
      ...event,
      eventId: "turn:private-thread:turn-3",
      provider: "openai",
      model: "gpt-5.6-sol",
    });
    recordModelAnalyticsEvent({
      ...event,
      eventId: "turn:another-private-thread:turn-4",
      provider: "openai",
      model: "gpt-5.6-sol",
    });

    expect(readLocalModelAnalyticsEvents()).toHaveLength(3);
    expect(readLocalModelAnalyticsEvents().every((row) => row.costUsd === undefined)).toBe(true);
  });

  it("removes legacy persisted event IDs when reading saved data", () => {
    values.set(
      LOCAL_USAGE_KEY,
      JSON.stringify([
        {
          eventId: "turn:private-thread:turn-1",
          provider: "openai",
          model: "gpt-5.6-sol",
          occurredAt: "2026-01-12T10:00:00.000Z",
        },
      ]),
    );

    expect(readLocalModelAnalyticsEvents()).toEqual([
      { provider: "openai", model: "gpt-5.6-sol", occurredAt: "2026-01-12T10:00:00.000Z" },
    ]);
    expect(values.get(LOCAL_USAGE_KEY)).not.toContain("private-thread");
  });

  it("ignores malformed saved data", () => {
    values.set(LOCAL_USAGE_KEY, JSON.stringify([{ eventId: "bad", occurredAt: "not-a-date" }]));

    expect(readLocalModelAnalyticsEvents()).toEqual([]);
  });
});
