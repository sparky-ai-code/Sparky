import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OrchestrationThread } from "@sparky/contracts";

const mocks = vi.hoisted(() => ({
  recordPluginAnalyticsEvent: vi.fn(async (_event: { readonly type: string }) => true),
  recordAccountUsageEvent: vi.fn(async () => true),
}));

vi.mock("../components/plugins/pluginApi", () => ({
  recordPluginAnalyticsEvent: mocks.recordPluginAnalyticsEvent,
}));
vi.mock("./accountApi", () => ({ recordAccountUsageEvent: mocks.recordAccountUsageEvent }));

import { recordCompletedTurnUsage } from "./usageTelemetry";
import { readLocalModelAnalyticsEvents } from "./modelAnalytics";

const savedUsage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => savedUsage.get(key) ?? null,
  setItem: (key: string, value: string) => savedUsage.set(key, value),
};

beforeEach(() => {
  savedUsage.clear();
  mocks.recordPluginAnalyticsEvent.mockClear();
  mocks.recordAccountUsageEvent.mockClear();
  vi.stubGlobal("window", { localStorage: localStorageStub });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("completed-turn usage telemetry", () => {
  it("aggregates token usage across every model request in a turn", async () => {
    const thread = {
      id: "thread-1",
      latestTurn: { turnId: "turn-1", state: "completed", completedAt: "2026-02-01T12:00:00.000Z" },
      modelSelection: { instanceId: "openai", model: "gpt-5.6-sol" },
      updatedAt: "2026-02-01T12:00:00.000Z",
      activities: [
        {
          turnId: "turn-1",
          kind: "context-window.updated",
          payload: {
            lastUsedTokens: 130,
            lastInputTokens: 100,
            lastCachedInputTokens: 20,
            lastOutputTokens: 10,
          },
        },
        {
          turnId: "turn-1",
          kind: "context-window.updated",
          payload: {
            lastUsedTokens: 280,
            lastInputTokens: 200,
            lastCachedInputTokens: 50,
            lastOutputTokens: 30,
          },
        },
        {
          turnId: "turn-other",
          kind: "context-window.updated",
          payload: { lastUsedTokens: 10_000, lastInputTokens: 10_000 },
        },
      ],
    } as unknown as OrchestrationThread;

    await expect(recordCompletedTurnUsage({ environmentId: "environment-1", thread })).resolves.toBe(true);

    expect(readLocalModelAnalyticsEvents()).toEqual([
      expect.objectContaining({
        inputTokens: 300,
        cachedInputTokens: 70,
        outputTokens: 40,
        totalTokens: 410,
      }),
    ]);
    expect(mocks.recordAccountUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 300,
        cachedInputTokens: 70,
        outputTokens: 40,
        totalTokens: 410,
      }),
    );
    expect(
      mocks.recordPluginAnalyticsEvent.mock.calls.filter(([event]) => event.type === "model_request"),
    ).toHaveLength(2);
  });
});
