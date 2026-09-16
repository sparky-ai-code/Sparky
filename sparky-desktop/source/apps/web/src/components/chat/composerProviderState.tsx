import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@sparky/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@sparky/shared/model";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  DraftId,
  useComposerDraftModelState,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import {
  getFastModeState,
  getPrimaryTraitLabel,
  type FastModeState,
  shouldRenderTraitsControls,
  TraitsFastModeControl,
  TraitsMenuContent,
  TraitsPicker,
  TraitsSliderContent,
} from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  promptInjectionState?: ComposerPromptInjectionState;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

export type ComposerPromptInjectionState = "none" | "ultrathink";

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

export type TraitsRenderInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  nested?: boolean;
};

const latestTraitsInputByInstance = new Map<ProviderInstanceId, TraitsRenderInput>();

function rememberTraitsInput(input: TraitsRenderInput): void {
  if (!input.instanceId) return;
  latestTraitsInputByInstance.set(input.instanceId, input);
}

/**
 * Compatibility bridge for the current composer. PR #20 originally passed
 * these values directly into ProviderModelPicker. The current composer still
 * calls the traits render helpers separately, so keep the exact PR #20 picker
 * UI while sourcing the same render input without replacing newer composer
 * code.
 */
export function getProviderTraitsRenderInput(
  instanceId: ProviderInstanceId,
): TraitsRenderInput | null {
  return latestTraitsInputByInstance.get(instanceId) ?? null;
}

/**
 * Read the live option selection from the same composer draft store that sends
 * the turn. The render-input bridge supplies descriptor context, while the
 * draft store is the reactive source of truth for the current selection.
 */
export function useProviderTraitsRenderInput(
  instanceId: ProviderInstanceId,
): TraitsRenderInput | null {
  const bridgedInput = getProviderTraitsRenderInput(instanceId);
  const threadTarget = bridgedInput?.threadRef ?? bridgedInput?.draftId ?? DraftId.make("");
  const draftModelState = useComposerDraftModelState(threadTarget);

  if (!bridgedInput) return null;

  const hasStoredSelection = Object.prototype.hasOwnProperty.call(
    draftModelState.modelSelectionByProvider,
    instanceId,
  );
  if (!hasStoredSelection) return bridgedInput;

  return {
    ...bridgedInput,
    modelOptions: draftModelState.modelSelectionByProvider[instanceId]?.options,
  };
}

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "none";
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const { provider, model, models, modelOptions, promptInjectionState = "none" } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({ caps, selections: modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === "ultrathink";

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildProviderOptionSelectionsFromDescriptors(descriptors),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

type TraitsControlComponent =
  | typeof TraitsMenuContent
  | typeof TraitsPicker
  | typeof TraitsSliderContent;

function ReactiveTraitsControl({
  Component,
  input,
}: {
  Component: TraitsControlComponent;
  input: TraitsRenderInput;
}) {
  const [modelOptions, setModelOptions] = useState(input.modelOptions);
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);

  useEffect(() => {
    setModelOptions(input.modelOptions);
  }, [input.modelOptions]);

  const updateModelOptions = useCallback(
    (nextOptions: ReadonlyArray<ProviderOptionSelection> | undefined) => {
      // Keep the open model selector responsive immediately. The compatibility
      // bridge is a snapshot, so waiting for its parent to rerender leaves the
      // previous effort visibly selected until the picker is closed/reopened.
      setModelOptions(nextOptions);

      const threadTarget = input.threadRef ?? input.draftId;
      if (!threadTarget) return;
      setProviderModelOptions(threadTarget, input.provider, nextOptions, {
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        model: input.model,
        persistSticky: true,
      });
    },
    [
      input.draftId,
      input.instanceId,
      input.model,
      input.provider,
      input.threadRef,
      setProviderModelOptions,
    ],
  );

  return (
    <Component
      provider={input.provider}
      {...(input.instanceId ? { instanceId: input.instanceId } : {})}
      models={input.models}
      model={input.model}
      modelOptions={modelOptions}
      prompt={input.prompt}
      onPromptChange={input.onPromptChange}
      onModelOptionsChange={updateModelOptions}
      {...(input.nested !== undefined ? { nested: input.nested } : {})}
    />
  );
}

function renderTraitsControl(
  Component: TraitsControlComponent,
  input: TraitsRenderInput,
): ReactNode {
  const { provider, instanceId, threadRef, draftId, model, models, modelOptions, prompt } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({ provider, models, model, modelOptions, prompt })
  ) {
    return null;
  }
  return (
    <ReactiveTraitsControl
      key={`${instanceId ?? provider}:${model}`}
      Component={Component}
      input={input}
    />
  );
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  rememberTraitsInput(input);
  // Current main passes this node into the compact footer menu. PR #20 moved
  // traits into ProviderModelPicker instead, and only requested nested content
  // for that picker. Preserve that behavior without changing ChatComposer.
  if (!input.nested) return null;
  return renderTraitsControl(TraitsMenuContent, input);
}

export function renderProviderTraitsSliderContent(input: TraitsRenderInput): ReactNode {
  rememberTraitsInput(input);
  return renderTraitsControl(TraitsSliderContent, input);
}

export function renderProviderFastModeControl(
  input: TraitsRenderInput,
  placement: "trigger" | "popup",
): ReactNode {
  rememberTraitsInput(input);
  const hasTarget = input.threadRef !== undefined || input.draftId !== undefined;
  if (!hasTarget) return null;
  return (
    <TraitsFastModeControl
      provider={input.provider}
      {...(input.instanceId ? { instanceId: input.instanceId } : {})}
      models={input.models}
      {...(input.threadRef ? { threadRef: input.threadRef } : {})}
      {...(input.draftId ? { draftId: input.draftId } : {})}
      model={input.model}
      modelOptions={input.modelOptions}
      prompt={input.prompt}
      onPromptChange={input.onPromptChange}
      placement={placement}
    />
  );
}

export function getProviderFastModeState(input: TraitsRenderInput): FastModeState {
  rememberTraitsInput(input);
  return getFastModeState({
    provider: input.provider,
    models: input.models,
    model: input.model,
    prompt: input.prompt,
    modelOptions: input.modelOptions,
  });
}

export function getProviderTraitsPrimaryLabel(input: TraitsRenderInput): string | null {
  rememberTraitsInput(input);
  return getPrimaryTraitLabel({
    provider: input.provider,
    models: input.models,
    model: input.model,
    prompt: input.prompt,
    modelOptions: input.modelOptions,
  });
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  // Current main still renders this return value as a separate footer control.
  // PR #20 moved those controls inside ProviderModelPicker, so retain the input
  // for the picker and deliberately render nothing here.
  rememberTraitsInput(input);
  return null;
}
