import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  it("stores only chart metadata and deduplicates events", () => {
    const event = {
      eventId: "turn:private-thread:turn-1",
      environmentId: "private-environment",
      threadId: "private-thread",
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      occurredAt: "2026-01-12T10:00:00.000Z",
    };

    recordModelAnalyticsEvent(event);
    recordModelAnalyticsEvent(event);

    expect(readLocalModelAnalyticsEvents()).toEqual([
      {
        eventId: event.eventId,
        provider: event.provider,
        model: event.model,
        totalTokens: event.totalTokens,
        occurredAt: event.occurredAt,
      },
    ]);
    expect(values.get(LOCAL_USAGE_KEY)).not.toContain("private-environment");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores malformed saved data", () => {
    values.set(LOCAL_USAGE_KEY, JSON.stringify([{ eventId: "bad", occurredAt: "not-a-date" }]));

    expect(readLocalModelAnalyticsEvents()).toEqual([]);
  });
});
