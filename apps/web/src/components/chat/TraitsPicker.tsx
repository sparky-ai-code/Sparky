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
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { VariantProps } from "class-variance-authority";
import { CheckIcon, ChevronDownIcon, ZapIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack } from "../ui/slider";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

type SliderSnapAnimation = {
  indicatorWidthPercent: number;
  keyIndex: number;
  thumbOffsetPx: number;
};

const SLIDER_SNAP_DURATION_MS = 240;

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function DefaultBadge() {
  return (
    <Badge
      variant="outline"
      className="inline-flex h-4 w-fit min-w-0 items-center justify-center gap-0 border-border/70 bg-muted/60 px-1.5 py-0 font-semibold text-[10px] text-muted-foreground leading-none sm:h-4"
    >
      Default
    </Badge>
  );
}

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

function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : null;
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({
    caps,
    selections: modelOptions,
  });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const fastModeEnabled =
    typeof fastModeDescriptor?.currentValue === "boolean" ? fastModeDescriptor.currentValue : false;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    fastModeEnabled,
    contextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    selectedAgent,
    selectedAgentLabel,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls: showEffort || showThinking || showFastMode || showContextWindow || showAgent,
  };
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export function getPrimaryTraitLabel(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
}): string | null {
  const { primarySelectDescriptor, ultrathinkPromptControlled } = getTraitsSectionVisibility(input);
  if (!primarySelectDescriptor) return null;
  if (ultrathinkPromptControlled) return "Ultrathink";
  return getProviderOptionCurrentLabel(primarySelectDescriptor) ?? null;
}

export type FastModeState = {
  supported: boolean;
  enabled: boolean;
};

export function getFastModeState(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
}): FastModeState {
  const { fastModeDescriptor, fastModeEnabled } = getTraitsSectionVisibility(input);
  return {
    supported: fastModeDescriptor !== null,
    enabled: fastModeDescriptor !== null && fastModeEnabled,
  };
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  nested?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

function useProviderOptionsUpdater(props: TraitsMenuContentProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  return useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in props) {
        props.onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = props.threadRef ?? props.draftId;
      if (!threadTarget) return;
      setProviderModelOptions(threadTarget, props.provider, nextOptions, {
        ...(props.instanceId ? { instanceId: props.instanceId } : {}),
        model: props.model,
        persistSticky: true,
      });
    },
    [props, setProviderModelOptions],
  );
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  nested = false,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = persistence.threadRef ?? persistence.draftId;
      if (!threadTarget) {
        return;
      }
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        ...(instanceId ? { instanceId } : {}),
        model,
        persistSticky: true,
      });
    },
    [instanceId, model, persistence, provider, setProviderModelOptions],
  );
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasAnyControls,
  } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (!value) return;
    if (descriptor.promptInjectedValues?.includes(value)) {
      const nextPrompt =
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink");
      onPromptChange(nextPrompt);
      return;
    }
    if (ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id) return;
    if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
      const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
      onPromptChange(stripped);
    }
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
  };

  if (!hasAnyControls) {
    return null;
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => {
        const selectedValue =
          ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
            ? "ultrathink"
            : (getDescriptorStringValue(descriptor) ?? "");
        const selectedLabel =
          selectedValue === "ultrathink"
            ? "Ultrathink"
            : (descriptor.options.find((option) => option.id === selectedValue)?.label ??
              selectedValue);

        if (nested) {
          return (
            <MenuSub key={descriptor.id}>
              <MenuSubTrigger className="grid grid-cols-[auto_minmax(0,1fr)_auto]">
                <span>{descriptor.label}</span>
                <span className="truncate text-right text-muted-foreground">{selectedLabel}</span>
              </MenuSubTrigger>
              <MenuSubPopup className="w-64">
                {ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id ? (
                  <div className="px-2 pb-1.5 text-xs text-muted-foreground/80">
                    Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change
                    this option.
                  </div>
                ) : null}
                <MenuRadioGroup
                  value={selectedValue}
                  onValueChange={(value) => handleSelectChange(descriptor, value)}
                >
                  {descriptor.options.map((option) => (
                    <MenuRadioItem
                      key={option.id}
                      value={option.id}
                      hideIndicator
                      disabled={
                        ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id
                      }
                    >
                      <span className="flex w-full min-w-0 items-center justify-between gap-3">
                        <span className="min-w-0 truncate">
                          {option.label}
                          {option.isDefault ? (
                            <>
                              {" "}
                              <DefaultBadge />
                            </>
                          ) : null}
                        </span>
                        {option.id === selectedValue ? (
                          <CheckIcon className="size-3.5 shrink-0 text-blue-400" />
                        ) : null}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
          );
        }

        return (
          <div key={descriptor.id}>
            {index > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              {ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id ? (
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                  Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
                  option.
                </div>
              ) : null}
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => handleSelectChange(descriptor, value)}
              >
                {descriptor.options.map((option) => (
                  <MenuRadioItem
                    key={option.id}
                    value={option.id}
                    hideIndicator
                    disabled={ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id}
                  >
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {option.label}
                        {option.isDefault ? (
                          <>
                            {" "}
                            <DefaultBadge />
                          </>
                        ) : null}
                      </span>
                      {option.id === selectedValue ? (
                        <CheckIcon className="size-3.5 shrink-0 text-blue-400" />
                      ) : null}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
      {booleanDescriptors.map((descriptor, index) => {
        const selectedValue = descriptor.currentValue === true ? "on" : "off";
        const selectedLabel = selectedValue === "on" ? "On" : "Off";
        const handleBooleanChange = (value: string) => {
          updateDescriptors(
            replaceDescriptorCurrentValue(descriptors, descriptor.id, value === "on"),
          );
        };

        if (nested) {
          return (
            <MenuSub key={descriptor.id}>
              <MenuSubTrigger className="grid grid-cols-[auto_minmax(0,1fr)_auto]">
                <span>{descriptor.label}</span>
                <span className="truncate text-right text-muted-foreground">{selectedLabel}</span>
              </MenuSubTrigger>
              <MenuSubPopup className="w-48">
                <MenuRadioGroup value={selectedValue} onValueChange={handleBooleanChange}>
                  {(["on", "off"] as const).map((value) => (
                    <MenuRadioItem key={value} value={value} hideIndicator>
                      <span className="flex w-full min-w-0 items-center justify-between gap-3">
                        <span>{value === "on" ? "On" : "Off"}</span>
                        {value === selectedValue ? (
                          <CheckIcon className="size-3.5 shrink-0 text-blue-400" />
                        ) : null}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
          );
        }

        return (
          <div key={descriptor.id}>
            {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              <MenuRadioGroup value={selectedValue} onValueChange={handleBooleanChange}>
                {(["on", "off"] as const).map((value) => (
                  <MenuRadioItem key={value} value={value} hideIndicator>
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span>{value === "on" ? "On" : "Off"}</span>
                      {value === selectedValue ? (
                        <CheckIcon className="size-3.5 shrink-0 text-blue-400" />
                      ) : null}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
    </>
  );
});

export const TraitsFastModeControl = memo(function TraitsFastModeControl(
  props: TraitsMenuContentProps & TraitsPersistence & { placement?: "trigger" | "popup" },
) {
  const updateModelOptions = useProviderOptionsUpdater(props);
  const { descriptors, fastModeDescriptor, fastModeEnabled } = getTraitsSectionVisibility({
    provider: props.provider,
    models: props.models,
    model: props.model,
    prompt: props.prompt,
    modelOptions: props.modelOptions,
  });
  const supported = fastModeDescriptor !== null;
  const tooltip = supported
    ? fastModeEnabled
      ? "Turn Fast priority off"
      : "Turn Fast priority on"
    : "This provider doesn't support fast mode";
  const isTriggerPlacement = props.placement === "trigger";

  const toggleFastMode = () => {
    if (!fastModeDescriptor) return;
    updateModelOptions(
      buildProviderOptionSelectionsFromDescriptors(
        replaceDescriptorCurrentValue(descriptors, fastModeDescriptor.id, !fastModeEnabled),
      ),
    );
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex shrink-0 rounded-full"
            tabIndex={supported ? undefined : 0}
            data-fast-mode-supported={supported ? "true" : "false"}
          />
        }
      >
        <Button
          type="button"
          size={isTriggerPlacement ? "icon-sm" : "icon-xs"}
          variant="ghost"
          aria-label={tooltip}
          aria-pressed={supported ? fastModeEnabled : undefined}
          disabled={!supported}
          data-fast-mode-enabled={fastModeEnabled ? "true" : "false"}
          className={cn(
            "rounded-full transition-colors duration-200 ease-out motion-reduce:transition-none",
            supported && fastModeEnabled
              ? "text-blue-500 hover:bg-transparent hover:text-blue-500"
              : supported
                ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                : "text-muted-foreground/35 opacity-100",
          )}
          onClick={toggleFastMode}
        >
          <ZapIcon
            className={cn(
              "size-4 transition-colors duration-200 ease-out motion-reduce:transition-none",
              fastModeEnabled
                ? "fill-current text-blue-500"
                : supported
                  ? "fill-transparent text-muted-foreground"
                  : "fill-transparent text-muted-foreground/35 grayscale",
            )}
            aria-hidden
          />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
});

export const TraitsSliderContent = memo(function TraitsSliderContent(
  props: TraitsMenuContentProps & TraitsPersistence,
) {
  const updateModelOptions = useProviderOptionsUpdater(props);
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled, ultrathinkInBodyText } =
    getTraitsSectionVisibility({
      provider: props.provider,
      models: props.models,
      model: props.model,
      prompt: props.prompt,
      modelOptions: props.modelOptions,
      ...(props.allowPromptInjectedEffort !== undefined
        ? { allowPromptInjectedEffort: props.allowPromptInjectedEffort }
        : {}),
    });
  const options = primarySelectDescriptor?.options ?? [];
  const selectedValue = ultrathinkPromptControlled
    ? "ultrathink"
    : (getDescriptorStringValue(primarySelectDescriptor) ?? "");
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selectedValue),
  );
  const [sliderRevision, setSliderRevision] = useState(0);
  const [sliderSnap, setSliderSnap] = useState<SliderSnapAnimation | null>(null);
  const sliderContentRef = useRef<HTMLDivElement>(null);
  const snapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (snapTimeoutRef.current !== null) {
        clearTimeout(snapTimeoutRef.current);
      }
    };
  }, []);

  if (!primarySelectDescriptor || options.length === 0) {
    return null;
  }

  const optionCount = options.length;
  const maxIndex = Math.max(0, optionCount - 1);
  const previewIndex = Math.max(0, Math.min(maxIndex, selectedIndex));
  const previewLabel = options[previewIndex]?.label ?? selectedValue;

  const getSliderSnapAnimation = (nextIndex: number): SliderSnapAnimation | null => {
    const sliderContent = sliderContentRef.current;
    const control = sliderContent?.querySelector<HTMLElement>('[data-slot="slider-control"]');
    const thumb = sliderContent?.querySelector<HTMLElement>('[data-slot="slider-thumb"]');
    const targetTick = sliderContent?.querySelector<HTMLElement>(
      `[data-slider-option-index="${nextIndex}"]`,
    );
    if (!control || !thumb || !targetTick) return null;

    const controlRect = control.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const targetTickRect = targetTick.getBoundingClientRect();
    if (controlRect.width === 0) return null;

    const currentThumbCenter = thumbRect.left + thumbRect.width / 2;
    const targetCenter = targetTickRect.left + targetTickRect.width / 2;
    const indicatorWidthPercent = Math.max(
      0,
      Math.min(100, ((targetCenter - controlRect.left) / controlRect.width) * 100),
    );

    return {
      indicatorWidthPercent,
      keyIndex: selectedIndex,
      thumbOffsetPx: targetCenter - currentThumbCenter,
    };
  };

  const commitValue = (value: number | readonly number[], reason?: string) => {
    const nextValue = typeof value === "number" ? value : (value[0] ?? 0);
    const nextIndex = Math.max(0, Math.min(maxIndex, Math.round(nextValue)));
    const option = options[nextIndex];
    const shouldAnimateSnap =
      Boolean(option) &&
      (reason === "drag" || reason === "track-press") &&
      Math.abs(nextValue - nextIndex) > 0.001;
    const snapAnimation = shouldAnimateSnap ? getSliderSnapAnimation(nextIndex) : null;

    const applyOption = () => {
      if (!option || ultrathinkInBodyText || option.id === selectedValue) return;
      if (primarySelectDescriptor.promptInjectedValues?.includes(option.id)) {
        const nextPrompt =
          props.prompt.trim().length === 0
            ? ULTRATHINK_PROMPT_PREFIX
            : applyClaudePromptEffortPrefix(props.prompt, "ultrathink");
        props.onPromptChange(nextPrompt);
        return;
      }
      if (ultrathinkPromptControlled) {
        props.onPromptChange(props.prompt.replace(/^Ultrathink:\s*/i, ""));
      }
      updateModelOptions(
        buildProviderOptionSelectionsFromDescriptors(
          replaceDescriptorCurrentValue(descriptors, primarySelectDescriptor.id, option.id),
        ),
      );
    };

    if (snapTimeoutRef.current !== null) {
      clearTimeout(snapTimeoutRef.current);
      snapTimeoutRef.current = null;
    }
    if (snapAnimation) {
      setSliderSnap(snapAnimation);
      snapTimeoutRef.current = setTimeout(() => {
        setSliderSnap(null);
        setSliderRevision((revision) => revision + 1);
        snapTimeoutRef.current = null;
        applyOption();
      }, SLIDER_SNAP_DURATION_MS);
      return;
    }

    setSliderSnap(null);
    setSliderRevision((revision) => revision + 1);
    applyOption();
  };

  const handleSliderKeyDown = (event: KeyboardEvent) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextIndex = previewIndex - 1;
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextIndex = previewIndex + 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = maxIndex;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    commitValue(Math.max(0, Math.min(maxIndex, nextIndex)));
  };

  return (
    <div ref={sliderContentRef} className="px-4 pb-1" data-traits-slider-content="true">
      <Slider
        key={`${primarySelectDescriptor.id}:${sliderSnap?.keyIndex ?? selectedIndex}:${sliderRevision}`}
        aria-label={primarySelectDescriptor.label}
        data-slider-snapping={sliderSnap ? "" : undefined}
        disabled={ultrathinkInBodyText}
        min={0}
        max={maxIndex}
        step={0.01}
        largeStep={1}
        thumbAlignment="edge"
        defaultValue={selectedIndex}
        onValueCommitted={(value, details) => commitValue(value, details.reason)}
      >
        <SliderControl>
          <SliderTrack>
            <SliderIndicator
              className="inset-y-0 left-0 bg-linear-to-r from-blue-600 via-blue-500 to-sky-400"
              style={sliderSnap ? { width: `${sliderSnap.indicatorWidthPercent}%` } : undefined}
            />
          </SliderTrack>
          <div className="pointer-events-none absolute inset-x-4 inset-y-0" aria-hidden>
            {options.map((option, index) => (
              <span
                key={option.id}
                className={cn(
                  "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[background-color,box-shadow,scale,opacity] duration-200 ease-out motion-reduce:transition-none",
                  index === previewIndex
                    ? "scale-150 bg-white shadow-[0_0_8px_1px_rgb(255_255_255/0.45)]"
                    : index < selectedIndex
                      ? "bg-white/70"
                      : "bg-foreground/20",
                )}
                data-slider-option-index={index}
                style={{ left: `${optionCount === 1 ? 50 : (index / (optionCount - 1)) * 100}%` }}
              />
            ))}
          </div>
          <SliderThumb
            aria-label={`${primarySelectDescriptor.label}: ${previewLabel}`}
            onKeyDown={handleSliderKeyDown}
            style={
              sliderSnap ? { transform: `translateX(${sliderSnap.thumbOffsetPx}px)` } : undefined
            }
          />
        </SliderControl>
      </Slider>
      <div
        key={previewLabel}
        className="sr-only transition-opacity duration-150"
        aria-live="polite"
        data-slider-preview-label={previewLabel}
      >
        {previewLabel}
      </div>
    </div>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled } =
    getTraitsSectionVisibility({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    });
  if (
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    })
  ) {
    return null;
  }

  const triggerLabels: Array<string> = [];
  for (const descriptor of descriptors) {
    const label =
      ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
        ? "Ultrathink"
        : descriptor.type === "boolean"
          ? descriptor.id === "fastMode"
            ? descriptor.currentValue === true
              ? "Fast"
              : "Normal"
            : `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`
          : getProviderOptionCurrentLabel(descriptor);
    if (typeof label === "string" && label.length > 0) {
      triggerLabels.push(label);
    }
  }
  const triggerLabel = triggerLabels.join(" · ");

  const isCodexStyle = provider === "codex";

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant ?? "ghost"}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
                : "shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
            {triggerLabel}
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </span>
        ) : (
          <>
            <span>{triggerLabel}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
