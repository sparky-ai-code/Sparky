import { ProviderInstanceId } from "@sparky/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeSparkyThreadTitlePrompt,
  resolveSparkyTextGenerationRuntimeOptions,
} from "./SparkyDriver.ts";

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
