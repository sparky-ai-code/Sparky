// @effect-diagnostics nodeBuiltinImport:off globalDate:off

import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CODEX_OAUTH_FALLBACK_CONTEXT_WINDOW_TOKENS,
  isCodexOAuthModel,
  normalizeCodexOAuthEffectiveContextWindowTokens,
  normalizeCodexOAuthContextWindowTokens,
  readCodexOAuthContextWindow,
} from "./codexContextWindow.ts";

describe("Codex OAuth context policy", () => {
  it("caps model-wide metadata for OAuth Codex without changing API-key providers", () => {
    expect(isCodexOAuthModel("openai-codex/gpt-5.6-codex")).toBe(true);
    expect(
      normalizeCodexOAuthContextWindowTokens("openai-codex/gpt-5.6-codex", 1_050_000),
    ).toBe(CODEX_OAUTH_FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(normalizeCodexOAuthContextWindowTokens("openai/gpt-5.6", 1_050_000)).toBe(1_050_000);
  });

  it("uses the conservative entitlement fallback when usage metadata is absent", () => {
    expect(normalizeCodexOAuthContextWindowTokens("openai-codex/gpt-5.6-codex", undefined)).toBe(
      CODEX_OAUTH_FALLBACK_CONTEXT_WINDOW_TOKENS,
    );
  });

  it("uses the per-model raw and effective limits from Codex models_cache.json", () => {
    const codexHome = NodePath.join(
      NodeOS.tmpdir(),
      `sparky-codex-context-${process.pid}-${Date.now()}`,
    );
    NodeFS.mkdirSync(codexHome, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-test",
            context_window: 272_000,
            max_context_window: 372_000,
            effective_context_window_percent: 95,
          },
        ],
      }),
      "utf8",
    );
    try {
      const environment = { SPARKY_CODEX_HOME: codexHome };
      expect(readCodexOAuthContextWindow("openai-codex/gpt-test", environment)).toEqual({
        contextWindowTokens: 272_000,
        maxContextWindowTokens: 372_000,
        effectiveContextWindowTokens: 258_400,
        maxEffectiveContextWindowTokens: 353_400,
        effectiveContextWindowPercent: 95,
      });
      expect(
        normalizeCodexOAuthContextWindowTokens("openai-codex/gpt-test", 1_000_000, environment),
      ).toBe(372_000);
      expect(
        normalizeCodexOAuthEffectiveContextWindowTokens(
          "openai-codex/gpt-test",
          1_000_000,
          environment,
        ),
      ).toBe(353_400);
    } finally {
      NodeFS.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
