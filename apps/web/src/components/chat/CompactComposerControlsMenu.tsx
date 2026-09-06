import { ProviderInteractionMode, RuntimeMode } from "@sparky/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListTodoIcon, PencilRulerIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import "./composerPlanModeChip.css";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <>
      {props.interactionMode === "plan" ? (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={props.onToggleInteractionMode}
          aria-label="Plan mode — click to return to normal build mode"
        >
          <PencilRulerIcon className="size-4" aria-hidden />
          <span>Plan</span>
        </Button>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
              aria-label="More composer controls"
            />
          }
        >
          <EllipsisIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="start">
          {props.traitsMenuContent ? (
            <>
              {props.traitsMenuContent}
              <MenuDivider />
            </>
          ) : null}
          {props.showInteractionModeToggle ? (
            <>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
              <MenuRadioGroup
                value={props.interactionMode}
                onValueChange={(value) => {
                  if (!value || value === props.interactionMode) return;
                  props.onToggleInteractionMode();
                }}
              >
                <MenuRadioItem value="default">Chat</MenuRadioItem>
                <MenuRadioItem value="plan">Plan</MenuRadioItem>
              </MenuRadioGroup>
              <MenuDivider />
            </>
          ) : null}
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (!value || value === props.runtimeMode) return;
              const nextMode = value as RuntimeMode;
              if (
                nextMode === "full-access" &&
                props.runtimeMode !== "full-access" &&
                !window.confirm(
                  "Enable Full access? This lets the model run commands and make file changes without asking first. Destructive actions, including deleting or overwriting files, could happen.",
                )
              ) {
                return;
              }
              props.onRuntimeModeChange(nextMode);
            }}
          >
            <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
            <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
            <MenuRadioItem value="full-access">Full access</MenuRadioItem>
          </MenuRadioGroup>
          {props.activePlan ? (
            <>
              <MenuDivider />
              <MenuItem onClick={props.onTogglePlanSidebar}>
                <ListTodoIcon className="size-4 shrink-0" />
                {props.planSidebarOpen
                  ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                  : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </>
  );
});
