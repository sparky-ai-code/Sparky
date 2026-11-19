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
        costUsd: 0.001008,
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

  it("estimates every OpenAI model in the Sparky Codex catalog with cached-input rates", () => {
    const models = [
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ];

    for (const model of models) {
      expect(
        estimateModelApiCostUsd(`openai-codex/${model}`, {
          inputTokens: 1_000_000,
          cachedInputTokens: 500_000,
          outputTokens: 100_000,
        }),
      ).toBeGreaterThan(0);
    }

    expect(
      estimateModelApiCostUsd("openai-codex/gpt-6-luna", {
        inputTokens: 1_000_000,
        cachedInputTokens: 500_000,
        outputTokens: 100_000,
      }),
    ).toBeCloseTo(0.105);
  });

  it("backfills estimates for previously saved rows when full usage is available", () => {
    values.set(
      LOCAL_USAGE_KEY,
      JSON.stringify([
        {
          provider: "openai-codex",
          model: "gpt-6-luna",
          inputTokens: 1_000,
          cachedInputTokens: 500,
          outputTokens: 100,
          occurredAt: "2026-01-12T10:00:00.000Z",
        },
      ]),
    );

    expect(readLocalModelAnalyticsEvents()[0]?.costUsd).toBeCloseTo(0.000105);
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
