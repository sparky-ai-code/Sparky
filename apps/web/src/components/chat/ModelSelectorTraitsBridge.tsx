import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@sparky/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@sparky/shared/model";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { ZapIcon } from "lucide-react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  clearModelSelectorControls,
  publishModelSelectorControls,
  type ModelSelectorControls,
} from "./modelSelectorControls";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

export type ModelSelectorTraitsBridgeProps = {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
};

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

export const ModelSelectorTraitsBridge = memo(function ModelSelectorTraitsBridge({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  threadRef,
  draftId,
}: ModelSelectorTraitsBridgeProps) {
  const ownerRef = useRef(Symbol("model-selector-traits"));
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const target = threadRef ?? draftId;

  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({ caps, selections: modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const fastModeDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean" && descriptor.id === "fastMode",
  );

  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if (!target) {
        return;
      }
      setProviderModelOptions(target, provider, nextOptions, {
        instanceId,
        model,
        persistSticky: true,
      });
    },
    [instanceId, model, provider, setProviderModelOptions, target],
  );

  const ultrathinkPromptControlled =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const reasoningValue = ultrathinkPromptControlled
    ? "ultrathink"
    : typeof primaryValue === "string"
      ? primaryValue
      : "";
  const reasoningValueLabel = ultrathinkPromptControlled
    ? "Ultrathink"
    : primarySelectDescriptor
      ? (getProviderOptionCurrentLabel(primarySelectDescriptor) ?? reasoningValue)
      : reasoningValue;
  const fastModeEnabled = fastModeDescriptor?.currentValue === true;

  const handleReasoningSelect = useCallback(
    (value: string) => {
      if (!primarySelectDescriptor || !value || ultrathinkInBodyText) {
        return;
      }
      if (primarySelectDescriptor.promptInjectedValues?.includes(value)) {
        const nextPrompt =
          prompt.trim().length === 0
            ? ULTRATHINK_PROMPT_PREFIX
            : applyClaudePromptEffortPrefix(prompt, "ultrathink");
        onPromptChange(nextPrompt);
        return;
      }
      if (ultrathinkPromptControlled) {
        onPromptChange(prompt.replace(/^Ultrathink:\s*/i, ""));
      }
      updateModelOptions(
        buildProviderOptionSelectionsFromDescriptors(
          replaceDescriptorCurrentValue(descriptors, primarySelectDescriptor.id, value),
        ),
      );
    },
    [
      descriptors,
      onPromptChange,
      primarySelectDescriptor,
      prompt,
      ultrathinkInBodyText,
      ultrathinkPromptControlled,
      updateModelOptions,
    ],
  );

  const toggleFastMode = useCallback(() => {
    if (!fastModeDescriptor) {
      return;
    }
    updateModelOptions(
      buildProviderOptionSelectionsFromDescriptors(
        replaceDescriptorCurrentValue(descriptors, fastModeDescriptor.id, !fastModeEnabled),
      ),
    );
  }, [descriptors, fastModeDescriptor, fastModeEnabled, updateModelOptions]);

  const controls = useMemo<ModelSelectorControls>(() => {
    const next: ModelSelectorControls = {};
    if (primarySelectDescriptor) {
      next.reasoning = {
        label: primarySelectDescriptor.label || "Effort",
        value: reasoningValue,
        valueLabel: reasoningValueLabel || reasoningValue,
        options: primarySelectDescriptor.options.map((option) => ({
          id: option.id,
          label: option.label,
        })),
        disabled: ultrathinkInBodyText,
        ...(ultrathinkInBodyText
          ? { disabledHint: "Remove ultrathink from the prompt to change reasoning effort." }
          : {}),
        onSelect: handleReasoningSelect,
      };
    }
    if (fastModeDescriptor) {
      next.fast = {
        enabled: fastModeEnabled,
        onToggle: toggleFastMode,
      };
    }
    return next;
  }, [
    fastModeDescriptor,
    fastModeEnabled,
    handleReasoningSelect,
    primarySelectDescriptor,
    reasoningValue,
    reasoningValueLabel,
    toggleFastMode,
    ultrathinkInBodyText,
  ]);

  useEffect(() => {
    const owner = ownerRef.current;
    publishModelSelectorControls(instanceId, owner, controls);
    return () => clearModelSelectorControls(instanceId, owner);
  }, [controls, instanceId]);

  if (!fastModeDescriptor) {
    return null;
  }

  const fastModeTooltip = fastModeEnabled
    ? "Fast mode on — click to use standard processing"
    : "Fast mode off — click to request priority processing";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className={cn(
              "rounded-full text-muted-foreground transition-colors hover:text-foreground",
              fastModeEnabled && "bg-amber-500/10 text-amber-400 hover:bg-amber-500/15 hover:text-amber-300",
            )}
            aria-label={fastModeEnabled ? "Disable fast mode" : "Enable fast mode"}
            aria-pressed={fastModeEnabled}
            onClick={toggleFastMode}
          />
        }
      >
        <ZapIcon
          aria-hidden="true"
          className={cn("size-4", fastModeEnabled && "fill-current")}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{fastModeTooltip}</TooltipPopup>
    </Tooltip>
  );
});
