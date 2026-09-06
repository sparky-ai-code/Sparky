import { ProviderDriverKind, ProviderInstanceId } from "@sparky/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  buildCompactModelProviderGroups,
  findCompactModelProviderGroup,
} from "./compactModelPicker";
import { getModelProviderPresentation } from "./providerIconUtils";

function providerEntry(input: {
  id: string;
  driver?: string;
  displayName?: string;
  continuationGroupKey?: string;
  ready?: boolean;
}): ProviderInstanceEntry {
  const driverKind = ProviderDriverKind.make(input.driver ?? "sparky");
  const instanceId = ProviderInstanceId.make(input.id);
  return {
    instanceId,
    driverKind,
    displayName: input.displayName ?? "Sparky",
    continuationGroupKey: input.continuationGroupKey,
    enabled: input.ready ?? true,
    installed: true,
    status: input.ready === false ? "disabled" : "ready",
    isDefault: true,
    isAvailable: true,
    snapshot: {} as ProviderInstanceEntry["snapshot"],
    models: [],
  };
}

describe("compact model picker groups", () => {
  it("groups Sparky models by their actual API provider and skips unavailable instances", () => {
    const sparky = providerEntry({ id: "sparky" });
    const unavailable = providerEntry({ id: "disabled", ready: false });
    const groups = buildCompactModelProviderGroups({
      instanceEntries: [sparky, unavailable],
      modelOptionsByInstance: new Map([
        [
          sparky.instanceId,
          [
            { slug: "openai/gpt-5.4", name: "GPT-5.4", subProvider: "OpenAI" },
            { slug: "openai/gpt-5.3", name: "GPT-5.3", subProvider: "OpenAI" },
            { slug: "anthropic/claude-sonnet", name: "Claude Sonnet", subProvider: "Claude" },
          ],
        ],
        [unavailable.instanceId, [{ slug: "hidden", name: "Hidden" }]],
      ]),
      lockedProvider: null,
    });

    expect(groups.map((group) => [group.label, group.models.length])).toEqual([
      ["OpenAI", 2],
      ["Claude", 1],
    ]);
    expect(
      findCompactModelProviderGroup(groups, sparky.instanceId, "anthropic/claude-sonnet")?.label,
    ).toBe("Claude");
  });

  it("keeps configured runtime instances separate and honors continuation locks", () => {
    const personal = providerEntry({
      id: "codex_personal",
      driver: "codex",
      displayName: "Codex Personal",
      continuationGroupKey: "personal",
    });
    const work = providerEntry({
      id: "codex_work",
      driver: "codex",
      displayName: "Codex Work",
      continuationGroupKey: "work",
    });
    const groups = buildCompactModelProviderGroups({
      instanceEntries: [personal, work],
      modelOptionsByInstance: new Map([
        [personal.instanceId, [{ slug: "gpt-5.4", name: "GPT-5.4" }]],
        [work.instanceId, [{ slug: "gpt-5.3", name: "GPT-5.3" }]],
      ]),
      lockedProvider: personal.driverKind,
      lockedContinuationGroupKey: "personal",
    });

    expect(groups.map((group) => group.label)).toEqual(["Codex Personal"]);
  });
});

describe("model provider presentation", () => {
  it("uses provider metadata first and falls back to model slug prefixes", () => {
    expect(
      getModelProviderPresentation({ slug: "custom/model", subProvider: "Google" })?.label,
    ).toBe("Google");
    expect(getModelProviderPresentation({ slug: "anthropic/claude-sonnet" })?.label).toBe("Claude");
    expect(getModelProviderPresentation({ slug: "openai/gpt-5.4" })?.label).toBe("OpenAI");
  });
});
