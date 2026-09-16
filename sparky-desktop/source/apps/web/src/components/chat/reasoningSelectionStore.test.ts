import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@sparky/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { getComposerProviderState } from "./composerProviderState";
import { getPrimaryTraitLabel } from "./TraitsPicker";

const REASONING_OPTIONS = [
  { id: "none", label: "None", isDefault: true },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "extra_high", label: "Extra High" },
  { id: "max", label: "Max" },
] as const;

function reasoningDescriptor(
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }> = REASONING_OPTIONS,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [...options],
    currentValue: options.find((option) => option.isDefault)?.id,
  };
}

function model(slug: string, descriptor: ProviderOptionDescriptor): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: { optionDescriptors: [descriptor] },
  };
}

function resetStore(): void {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("live reasoning selector state", () => {
  it("updates the composer label for every effort while the selector stays open", () => {
    resetStore();
    const draftId = DraftId.make("live-reasoning-selector");
    const scenarios = [
      {
        provider: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex_personal"),
        modelSlug: "gpt-5.6-luna",
      },
      {
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: ProviderInstanceId.make("claude_work"),
        modelSlug: "claude-sonnet-4",
      },
    ] as const;

    for (const scenario of scenarios) {
      const models = [model(scenario.modelSlug, reasoningDescriptor())];
      const effortSequence = ["low", "max", "low", "none", "medium", "high", "extra_high"];
      for (const effortId of effortSequence) {
        const option = REASONING_OPTIONS.find((candidate) => candidate.id === effortId);
        if (!option) throw new Error(`Missing test option: ${effortId}`);
        useComposerDraftStore
          .getState()
          .setProviderModelOptions(
            draftId,
            scenario.provider,
            [{ id: "reasoningEffort", value: option.id }],
            { instanceId: scenario.instanceId, model: scenario.modelSlug, persistSticky: true },
          );

        const selection = useComposerDraftStore.getState().getComposerDraft(draftId)
          ?.modelSelectionByProvider[scenario.instanceId];
        expect(
          getPrimaryTraitLabel({
            provider: scenario.provider,
            models,
            model: scenario.modelSlug,
            prompt: "",
            modelOptions: selection?.options,
          }),
        ).toBe(option.label);
      }
    }
  });

  it("keeps unsupported effort values constrained by the selected model capabilities", () => {
    resetStore();
    const draftId = DraftId.make("capability-constrained-reasoning");
    const provider = ProviderDriverKind.make("codex");
    const instanceId = ProviderInstanceId.make("codex_limited");
    const modelSlug = "limited-model";
    const models = [
      model(
        modelSlug,
        reasoningDescriptor([
          { id: "none", label: "None", isDefault: true },
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ]),
      ),
    ];

    useComposerDraftStore
      .getState()
      .setProviderModelOptions(draftId, provider, [{ id: "reasoningEffort", value: "max" }], {
        instanceId,
        model: modelSlug,
        persistSticky: true,
      });

    const selection = useComposerDraftStore.getState().getComposerDraft(draftId)
      ?.modelSelectionByProvider[instanceId];
    expect(
      getPrimaryTraitLabel({
        provider,
        models,
        model: modelSlug,
        prompt: "",
        modelOptions: selection?.options,
      }),
    ).toBe("None");
    expect(
      getComposerProviderState({
        provider,
        model: modelSlug,
        models,
        modelOptions: selection?.options,
      }).modelOptionsForDispatch,
    ).toEqual([{ id: "reasoningEffort", value: "none" }]);
  });
});
