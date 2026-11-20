import { ProviderInstanceId } from "@sparky/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeSnapshot,
  makeSparkyPromptSuggestionPrompt,
  makeSparkyThreadTitlePrompt,
  resolveSparkyTextGenerationRuntimeOptions,
} from "./SparkyDriver.ts";

const snapshotInput = {
  instanceId: ProviderInstanceId.make("sparky"),
  displayName: "Sparky",
  continuationKey: "sparky",
  enabled: true,
  binaryInstalled: true,
  binaryPath: "sparky",
} as const;

describe("Sparky provider snapshot", () => {
  it("reports a pending state while model discovery is still in flight", () => {
    const snapshot = makeSnapshot({
      ...snapshotInput,
      discovery: { models: [], configuredProviderCount: 0, errors: [] },
      pending: true,
    });

    expect(snapshot.message).toBe("Loading Sparky models…");
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.status).toBe("warning");
  });

  it("does not claim the models are missing while discovery is pending", () => {
    const snapshot = makeSnapshot({
      ...snapshotInput,
      discovery: { models: [], configuredProviderCount: 0, errors: [] },
      pending: true,
    });

    expect(snapshot.message).not.toBe("Connect a model in Models settings.");
    expect(snapshot.auth.status).not.toBe("unauthenticated");
  });

  it("keeps the connect-a-model message once discovery has finished without providers", () => {
    const snapshot = makeSnapshot({
      ...snapshotInput,
      discovery: { models: [], configuredProviderCount: 0, errors: [] },
    });

    expect(snapshot.message).toBe("Connect a model in Models settings.");
    expect(snapshot.auth.status).toBe("unauthenticated");
  });
});

describe("Sparky metadata generation", () => {
  it("forwards the selected model options to the independent text-only request", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("sparky"),
      model: "openai/gpt-5.6-luna",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "contextWindow", value: "200k" },
      ],
      contextWindowSource: "provider" as const,
    };

    expect(
      resolveSparkyTextGenerationRuntimeOptions({
        modelSelection,
        environment: {},
      }),
    ).toEqual({ reasoningEffort: "high", contextWindow: "200k" });
  });

  it("uses an explicit metadata prompt instead of asking the main agent to name itself", () => {
    const prompt = makeSparkyThreadTitlePrompt("Fix reconnect failures after resume");

    expect(prompt).toContain("separate metadata request");
    expect(prompt).toContain('{"title":"..."}');
    expect(prompt).toContain("Fix reconnect failures after resume");
    expect(prompt).not.toContain("Return at most 4 short words or 3 long ones for:");
  });
});

describe("makeSparkyPromptSuggestionPrompt", () => {
  it("asks for JSON-only output and embeds the completed round", () => {
    const prompt = makeSparkyPromptSuggestionPrompt({
      userMessage: "Add retry to the sync worker",
      assistantMessage: "Added exponential backoff to the sync worker.",
    });

    expect(prompt).toContain('{"suggestion":"..."}');
    expect(prompt).toContain("Do not answer the conversation");
    expect(prompt).toContain("Add retry to the sync worker");
    expect(prompt).toContain("Added exponential backoff to the sync worker.");
  });

  it("truncates oversized rounds so the prompt stays bounded", () => {
    const prompt = makeSparkyPromptSuggestionPrompt({
      userMessage: "x".repeat(10_000),
      assistantMessage: "ok",
    });

    expect(prompt.length).toBeLessThan(5_000);
    expect(prompt).toContain("[truncated]");
  });
});
