// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { ProviderInstanceId } from "@sparky/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  makeSparkyThreadTitlePrompt,
  resolveSparkyTextGenerationModelSelection,
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

  it("migrates the old OpenAI metadata default to OAuth only when Codex auth is configured", () => {
    const authDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), `sparky-codex-auth-${process.pid}-`),
    );
    NodeFS.writeFileSync(
      NodePath.join(authDirectory, "auth.json"),
      JSON.stringify({
        auth_mode: "siwc",
        tokens: {
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          client_id: "test-client",
          scope: "offline_access resource.invoke chatgpt.tokens.use.direct",
          expires: Date.now() + 3_600_000,
        },
      }),
      "utf8",
    );

    try {
      const oldDefault = {
        instanceId: ProviderInstanceId.make("sparky"),
        model: "openai/gpt-4o-mini",
      };
      const environment = { SPARKY_CODEX_HOME: authDirectory };

      expect(
        resolveSparkyTextGenerationModelSelection({
          modelSelection: oldDefault,
          environment,
        }).model,
      ).toBe("openai-codex/gpt-5.6-luna");
      expect(
        resolveSparkyTextGenerationModelSelection({
          modelSelection: oldDefault,
          environment: {},
        }),
      ).toBe(oldDefault);
      expect(
        resolveSparkyTextGenerationModelSelection({
          modelSelection: oldDefault,
          environment: { ...environment, OPENAI_API_KEY: "configured" },
        }),
      ).toBe(oldDefault);
      expect(
        resolveSparkyTextGenerationModelSelection({
          modelSelection: { ...oldDefault, model: "openai/gpt-4o" },
          environment,
        }).model,
      ).toBe("openai/gpt-4o");
    } finally {
      NodeFS.rmSync(authDirectory, { recursive: true, force: true });
    }
  });

  it("uses an explicit metadata prompt instead of asking the main agent to name itself", () => {
    const prompt = makeSparkyThreadTitlePrompt("Fix reconnect failures after resume");

    expect(prompt).toContain("separate metadata request");
    expect(prompt).toContain('{"title":"..."}');
    expect(prompt).toContain("Fix reconnect failures after resume");
    expect(prompt).not.toContain("Return at most 4 short words or 3 long ones for:");
  });
});
