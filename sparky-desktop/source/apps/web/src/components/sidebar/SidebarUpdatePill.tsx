import { DownloadIcon, RotateCwIcon } from "lucide-react";
import { useCallback } from "react";
import { isElectron } from "../../env";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function SidebarUpdateReleaseNotesTooltip({
  state,
  tooltip,
}: {
  readonly state: NonNullable<ReturnType<typeof useDesktopUpdateState>>;
  readonly tooltip: string;
}) {
  if (state.channel !== "nightly" || state.releaseNotes.length === 0) return tooltip;

  return (
    <div className="w-120 max-w-[calc(100vw-2rem)] text-left">
      <div className="px-1 text-sm leading-5 font-medium">{tooltip}</div>
      <div className="pointer-events-auto max-h-[min(28rem,calc(100vh-6rem))] overflow-y-auto px-1 pt-4 pb-1">
        {state.releaseNotes.map((releaseNote, index) => (
          <div key={releaseNote.version}>
            {index > 0 && <Separator className="my-3 bg-border/60" />}
            <section>
              <h3 className="text-muted-foreground text-xs leading-4 font-semibold">
                {index === 0 ? "What's changed" : `Changes in ${releaseNote.version}`}
              </h3>
              <ul className="mt-2 space-y-1.5 pl-4 text-xs leading-5 text-popover-foreground/90">
                {releaseNote.items.map((item, itemIndex) => (
                  <li className="list-disc break-words" key={`${releaseNote.version}-${itemIndex}`}>
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SidebarUpdatePill() {
  const state = useDesktopUpdateState();
  const visible = isElectron && shouldShowDesktopUpdateButton(state);
  const tooltip = state ? getDesktopUpdateButtonTooltip(state) : "Update available";
  const disabled = isDesktopUpdateButtonDisabled(state);
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";

  const handleAction = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !state || disabled || action === "none") return;
    if (action === "download") {
      void bridge.downloadUpdate().then((result) => {
        if (result.completed) {
          toastManager.add(stackedThreadToast({
            type: "success",
            title: "Update downloaded",
            description: "Restart the app from the update button to install it.",
          }));
        }
        if (!shouldToastDesktopUpdateActionResult(result)) return;
        const actionError = getDesktopUpdateActionError(result);
        if (actionError) toastManager.add(stackedThreadToast({
          type: "error",
          title: "Could not download update",
          description: actionError,
        }));
      }).catch(() => {
        toastManager.add(stackedThreadToast({
          type: "error",
          title: "Could not start update download",
          description: "Sparky couldn't start the update download. Try again in a moment.",
        }));
      });
      return;
    }
    if (action === "install") {
      if (!window.confirm(getDesktopUpdateInstallConfirmationMessage(state))) return;
      void bridge.installUpdate().then((result) => {
        if (!shouldToastDesktopUpdateActionResult(result)) return;
        const actionError = getDesktopUpdateActionError(result);
        if (actionError) toastManager.add(stackedThreadToast({
          type: "error",
          title: "Could not install update",
          description: actionError,
        }));
      }).catch(() => {
        toastManager.add(stackedThreadToast({
          type: "error",
          title: "Could not install update",
          description: "Sparky couldn't start the update install. Try again later.",
        }));
      });
    }
  }, [action, disabled, state]);

  if (!visible) return null;
  const Icon = action === "install" ? RotateCwIcon : DownloadIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={tooltip}
            aria-disabled={disabled || undefined}
            disabled={disabled}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleAction}
          />
        }
      >
        <Icon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup
        side="top"
        align="end"
        className={
          state?.channel === "nightly" && state.releaseNotes.length > 0
            ? "max-w-none text-balance"
            : undefined
        }
      >
        {state ? <SidebarUpdateReleaseNotesTooltip state={state} tooltip={tooltip} /> : tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}
