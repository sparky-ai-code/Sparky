import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@sparky/contracts";
import type { ModelSelectorStyle } from "@sparky/contracts/settings";
import { memo, useMemo, useState, type ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ZapIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getDisplayModelName,
  getModelProviderPresentation,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  buildCompactModelProviderGroups,
  findCompactModelProviderGroup,
} from "./compactModelPicker";
import { usePrimarySettings } from "../../hooks/useSettings";
import {
  getProviderFastModeState,
  getProviderTraitsPrimaryLabel,
  useProviderTraitsRenderInput,
  renderProviderFastModeControl,
  renderProviderTraitsMenuContent,
  renderProviderTraitsSliderContent,
} from "./composerProviderState";

const FAST_MODE_UNSUPPORTED_MESSAGE = "This provider doesn't support fast mode";

function UnsupportedFastModeControl({ placement }: { placement: "trigger" | "popup" }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex shrink-0 rounded-full"
            tabIndex={0}
            data-fast-mode-supported="false"
          />
        }
      >
        <Button
          type="button"
          size={placement === "trigger" ? "icon-sm" : "icon-xs"}
          variant="ghost"
          aria-label={FAST_MODE_UNSUPPORTED_MESSAGE}
          disabled
          className="rounded-full text-muted-foreground/35 opacity-100"
        >
          <ZapIcon
            className="size-4 fill-transparent text-muted-foreground/35 grayscale"
            aria-hidden
          />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="top">{FAST_MODE_UNSUPPORTED_MESSAGE}</TooltipPopup>
    </Tooltip>
  );
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and selected provider/model menu rows.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Configured instances used to build provider and model menu groups. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  selectorStyle?: ModelSelectorStyle;
  traitsMenuContent?: ReactNode;
  traitsSliderContent?: ReactNode;
  sliderValueLabel?: string | null;
  fastModeSupported?: boolean;
  fastModeEnabled?: boolean;
  fastModeTriggerControl?: ReactNode;
  fastModePopupControl?: ReactNode;
  compact?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const settings = usePrimarySettings();
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const [isAdvancedMenuOpen, setIsAdvancedMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const activeEntry = useMemo(
    () =>
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null,
    [props.activeInstanceId, props.instanceEntries],
  );
  const selectedInstanceOptions = props.modelOptionsByInstance.get(props.activeInstanceId) ?? [];
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === props.model) ??
    selectedInstanceOptions[0];
  const triggerTitle = selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model;
  const triggerLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : props.model;
  const selectedModelProvider = selectedModel ? getModelProviderPresentation(selectedModel) : null;
  const providerGroups = useMemo(
    () =>
      buildCompactModelProviderGroups({
        instanceEntries: props.instanceEntries,
        modelOptionsByInstance: props.modelOptionsByInstance,
        lockedProvider: props.lockedProvider,
        lockedContinuationGroupKey: props.lockedContinuationGroupKey ?? null,
      }),
    [
      props.instanceEntries,
      props.lockedContinuationGroupKey,
      props.lockedProvider,
      props.modelOptionsByInstance,
    ],
  );
  const selectedProviderGroup =
    findCompactModelProviderGroup(providerGroups, props.activeInstanceId, props.model) ??
    providerGroups[0] ??
    null;

  // PR #20 originally received these values directly from ChatComposer.
  // Current main keeps the same data but renders the traits helpers separately,
  // so use the compatibility snapshot only for controlled composer instances.
  const liveBridgedTraitsInput = useProviderTraitsRenderInput(props.activeInstanceId);
  const bridgedTraitsInput = props.open !== undefined ? liveBridgedTraitsInput : null;
  const selectorStyle = props.selectorStyle ?? settings.modelSelectorStyle;
  const traitsMenuContent =
    props.traitsMenuContent ??
    (bridgedTraitsInput
      ? renderProviderTraitsMenuContent({ ...bridgedTraitsInput, nested: true })
      : null);
  const traitsSliderContent =
    props.traitsSliderContent ??
    (bridgedTraitsInput ? renderProviderTraitsSliderContent(bridgedTraitsInput) : null);
  const primaryTraitLabel =
    props.sliderValueLabel !== undefined
      ? props.sliderValueLabel
      : bridgedTraitsInput
        ? getProviderTraitsPrimaryLabel(bridgedTraitsInput)
        : null;
  const bridgedFastModeState = bridgedTraitsInput
    ? getProviderFastModeState(bridgedTraitsInput)
    : { supported: false, enabled: false };
  const fastModeSupported = props.fastModeSupported ?? bridgedFastModeState.supported;
  const fastModeEnabled = props.fastModeEnabled ?? bridgedFastModeState.enabled;
  const fastModeTriggerControl =
    props.fastModeTriggerControl ??
    (bridgedTraitsInput ? renderProviderFastModeControl(bridgedTraitsInput, "trigger") : null);
  const fastModePopupControl =
    props.fastModePopupControl ??
    (bridgedTraitsInput ? renderProviderFastModeControl(bridgedTraitsInput, "popup") : null);

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (!open) setIsAdvancedMenuOpen(false);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  const selectProviderGroup = (groupId: string) => {
    const group = providerGroups.find((candidate) => candidate.id === groupId);
    const model = group?.models.find(
      (candidate) => !props.getModelDisabledReason?.(group.instanceId, candidate.slug),
    );
    if (group && model) {
      handleInstanceModelChange(group.instanceId, model.slug);
    }
  };

  const ActiveModelProviderIcon = selectedModelProvider?.Icon ?? null;
  const isSliderStyle = selectorStyle === "slider";
  // The selected reasoning/primary trait is part of the model selection itself,
  // so surface it in the composer trigger for both menu and slider selector styles.
  const displayedTriggerTitle = primaryTraitLabel
    ? `${triggerTitle} ${primaryTraitLabel}`
    : triggerTitle;
  const displayedTriggerLabel = primaryTraitLabel
    ? `${triggerLabel} · ${primaryTraitLabel}`
    : triggerLabel;
  const triggerButton = (
    <Button
      size="sm"
      variant={props.triggerVariant ?? "ghost"}
      data-chat-provider-model-picker="true"
      data-model-selector-style={isSliderStyle ? "slider" : "menu"}
      className={cn(
        "min-w-0 justify-between whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80",
        props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-3",
        props.triggerClassName,
      )}
      disabled={props.disabled}
    />
  );
  const triggerContent = (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {ActiveModelProviderIcon ? (
          <ActiveModelProviderIcon
            className={cn("size-4 shrink-0", props.activeProviderIconClassName)}
            aria-hidden
          />
        ) : activeEntry ? (
          <ProviderInstanceIcon
            driverKind={activeEntry.driverKind}
            displayName={activeEntry.displayName}
            accentColor={activeEntry.accentColor}
            showBadge={Boolean(activeEntry.accentColor)}
            className="size-4"
            iconClassName={cn("size-4", props.activeProviderIconClassName)}
            indicatorBackground="var(--input)"
            badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 overflow-hidden truncate" />}>
            {displayedTriggerTitle}
          </TooltipTrigger>
          <TooltipPopup side="top">{displayedTriggerLabel}</TooltipPopup>
        </Tooltip>
      </span>
      <ChevronDownIcon aria-hidden="true" className="!ms-0 !-me-1 size-3 shrink-0 opacity-60" />
    </>
  );
  const selectorMenuItems = (
    <>
      <MenuSub>
        <MenuSubTrigger className="grid grid-cols-[auto_minmax(0,1fr)_auto]">
          <span>Provider</span>
          <span className="flex min-w-0 items-center justify-end gap-2 text-muted-foreground">
            {selectedProviderGroup ? (
              <>
                {(() => {
                  const presentation = getModelProviderPresentation(
                    selectedProviderGroup.models[0] ?? { slug: "" },
                  );
                  const Icon = presentation?.Icon;
                  return Icon ? <Icon className="size-3.5" aria-hidden /> : null;
                })()}
                <span className="truncate">{selectedProviderGroup.label}</span>
              </>
            ) : (
              "Unavailable"
            )}
          </span>
        </MenuSubTrigger>
        <MenuSubPopup className="w-64">
          <MenuRadioGroup
            value={selectedProviderGroup?.id ?? ""}
            onValueChange={selectProviderGroup}
          >
            {providerGroups.map((group) => {
              const presentation = getModelProviderPresentation(group.models[0] ?? { slug: "" });
              const Icon = presentation?.Icon;
              const hasSelectableModel = group.models.some(
                (model) => !props.getModelDisabledReason?.(group.instanceId, model.slug),
              );
              return (
                <MenuRadioItem
                  key={group.id}
                  value={group.id}
                  hideIndicator
                  disabled={!hasSelectableModel}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {Icon ? (
                      <Icon className="size-4 shrink-0" aria-hidden />
                    ) : (
                      <ProviderInstanceIcon
                        driverKind={group.driverKind}
                        displayName={group.label}
                        className="size-4"
                        iconClassName="size-4"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{group.label}</span>
                    {group.id === selectedProviderGroup?.id ? (
                      <CheckIcon className="size-3.5 shrink-0" aria-hidden />
                    ) : null}
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuSubPopup>
      </MenuSub>

      <MenuSub>
        <MenuSubTrigger className="grid grid-cols-[auto_minmax(0,1fr)_auto]">
          <span>Model</span>
          <span className="truncate text-right text-muted-foreground">{triggerTitle}</span>
        </MenuSubTrigger>
        <MenuSubPopup className="w-72">
          <MenuRadioGroup
            value={props.model}
            onValueChange={(model) => {
              if (selectedProviderGroup) {
                handleInstanceModelChange(selectedProviderGroup.instanceId, model);
              }
            }}
          >
            {(selectedProviderGroup?.models ?? []).map((model) => {
              const disabledReason =
                props.getModelDisabledReason?.(selectedProviderGroup!.instanceId, model.slug) ??
                null;
              const presentation = getModelProviderPresentation(model);
              const Icon = presentation?.Icon;
              return (
                <MenuRadioItem
                  key={model.slug}
                  value={model.slug}
                  hideIndicator
                  disabled={Boolean(disabledReason)}
                  title={disabledReason ?? undefined}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
                    <span className="min-w-0 flex-1 truncate">{getDisplayModelName(model)}</span>
                    {model.slug === props.model ? (
                      <CheckIcon className="size-3.5 shrink-0" aria-hidden />
                    ) : null}
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuSubPopup>
      </MenuSub>
      {traitsMenuContent ? (
        <>
          <MenuSeparator />
          {traitsMenuContent}
        </>
      ) : null}
    </>
  );
  const handleOpenChange = (open: boolean) => {
    if (props.disabled) {
      setIsMenuOpen(false);
      return;
    }
    setIsMenuOpen(open);
  };

  if (isSliderStyle) {
    return (
      <div
        className="flex shrink-0 items-center gap-0.5"
        data-slider-model-picker-trigger-group="true"
        data-fast-mode-supported={fastModeSupported ? "true" : "false"}
        data-fast-mode-enabled={fastModeEnabled ? "true" : "false"}
      >
        {fastModeTriggerControl ?? <UnsupportedFastModeControl placement="trigger" />}
        <Popover open={isMenuOpen} onOpenChange={handleOpenChange}>
          <PopoverTrigger render={triggerButton}>{triggerContent}</PopoverTrigger>
          <PopoverPopup
            side="top"
            align="start"
            sideOffset={8}
            className="w-72 rounded-2xl transition-[width,height,scale,opacity,translate] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none data-ending-style:translate-y-1 data-starting-style:translate-y-1 data-ending-style:scale-95 data-starting-style:scale-95"
            viewportClassName="p-3"
            data-slider-model-picker-content="true"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <Menu open={isAdvancedMenuOpen} onOpenChange={setIsAdvancedMenuOpen}>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="group -ms-2 h-8 gap-1 px-2 text-muted-foreground transition-[color,background-color,transform] duration-200 hover:translate-x-0.5"
                    />
                  }
                >
                  Advanced
                  <ChevronRightIcon
                    className="size-3.5 opacity-60 transition-transform duration-200 group-data-[popup-open]:translate-x-0.5"
                    aria-hidden
                  />
                </MenuTrigger>
                <MenuPopup side="right" align="start" className="w-72">
                  {selectorMenuItems}
                </MenuPopup>
              </Menu>
              {fastModePopupControl ?? <UnsupportedFastModeControl placement="popup" />}
            </div>
            {traitsSliderContent ?? (
              <p className="px-1 pb-1 text-xs text-muted-foreground">
                This model has no adjustable effort levels. Use Advanced to change provider or
                model.
              </p>
            )}
          </PopoverPopup>
        </Popover>
      </div>
    );
  }

  return (
    <Menu open={isMenuOpen} onOpenChange={handleOpenChange}>
      <MenuTrigger render={triggerButton}>{triggerContent}</MenuTrigger>
      <MenuPopup align="start" className="w-72" data-model-picker-content="true">
        {selectorMenuItems}
      </MenuPopup>
    </Menu>
  );
});
