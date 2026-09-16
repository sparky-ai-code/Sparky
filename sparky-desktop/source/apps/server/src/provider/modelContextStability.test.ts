import { ProviderInstanceId, type ServerProviderModel } from "@sparky/contracts";
import { createModelSelection } from "@sparky/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  formatContextWindowTokens,
  getModelSelectionContextWindowTokens,
  mergeStableModelContext,
  parseContextWindowTokens,
  withModelSelectionContextWindow,
} from "./modelContextStability.ts";

const model = (
  contextWindow: string,
  source?: "provider" | "oauth" | "models.dev",
): ServerProviderModel => ({
  slug: "gpt-5.3-codex",
  name: "GPT-5.3 Codex",
  isCustom: false,
  ...(source !== undefined ? { contextWindowSource: source } : {}),
  capabilities: {
    optionDescriptors: [
      {
        id: "contextWindow",
        label: "Context window",
        type: "select",
        options: [{ id: contextWindow, label: contextWindow }],
        currentValue: contextWindow,
      },
    ],
  },
});

describe("model context stability", () => {
  it("keeps provider capacity when a later Models.dev refresh reports another value", () => {
    const stable = mergeStableModelContext(model("258400", "provider"), model("1m", "models.dev"));

    expect(stable.contextWindowSource).toBe("provider");
    expect(stable.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "contextWindow",
      currentValue: "258400",
    });
  });

  it("does not invent a context value when discovery has no capability", () => {
    const next: ServerProviderModel = {
      slug: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      isCustom: false,
      capabilities: null,
    };
    expect(mergeStableModelContext(next, next).capabilities).toBeNull();
    expect(parseContextWindowTokens("320k")).toBe(320_000);
    expect(parseContextWindowTokens("not-a-window")).toBeUndefined();
  });

  it("treats the OAuth entitlement fallback as authoritative", () => {
    const stable = mergeStableModelContext(model("320k", "oauth"), model("1m", "models.dev"));

    expect(stable.contextWindowSource).toBe("oauth");
    expect(stable.capabilities?.optionDescriptors?.[0]).toMatchObject({
      currentValue: "320k",
    });
  });

  it("persists the provider-observed selection in a canonical form", () => {
    const selection = createModelSelection(
      ProviderInstanceId.make("codex_personal"),
      "gpt-5.3-codex",
      [{ id: "effort", value: "high" }],
    );
    const observed = withModelSelectionContextWindow(selection, 258_400);

    expect(getModelSelectionContextWindowTokens(observed)).toBe(258_400);
    expect(observed.contextWindowSource).toBe("provider");
    expect(formatContextWindowTokens(1_000_000)).toBe("1m");
    expect(observed.options).toEqual([
      { id: "effort", value: "high" },
      { id: "contextWindow", value: "258400" },
    ]);
  });
});
