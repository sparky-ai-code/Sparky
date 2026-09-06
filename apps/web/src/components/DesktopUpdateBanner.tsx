import { DownloadIcon, RotateCwIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { isElectron } from "../env";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";

export function DesktopUpdateBanner() {
  const state = useDesktopUpdateState();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const version = state?.availableVersion ?? state?.downloadedVersion;
  const visible =
    isElectron &&
    state !== null &&
    (state.status === "available" ||
      state.status === "downloading" ||
      state.status === "downloaded") &&
    version !== null &&
    version !== undefined &&
    dismissedVersion !== version;

  const runAction = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !state || isDesktopUpdateButtonDisabled(state) || action === "none") return;

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) return;
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const message = getDesktopUpdateActionError(result);
          if (message) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not download update",
                description: message,
              }),
            );
          }
        })
        .catch(() => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: "Sparky couldn't start the update download. Try again in a moment.",
            }),
          );
        });
      return;
    }

    if (action === "install") {
      if (!window.confirm(getDesktopUpdateInstallConfirmationMessage(state))) return;
      void bridge.installUpdate().catch(() => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not install update",
            description: "Sparky couldn't start the update install. Try again later.",
          }),
        );
      });
    }
  }, [action, state]);

  if (!visible || !state || !version) return null;

  const isDownloading = state.status === "downloading";
  const isDownloaded = state.status === "downloaded";

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[70] flex justify-center px-4">
      <div className="pointer-events-auto flex w-full max-w-2xl items-center gap-3 rounded-2xl border border-primary/30 bg-card/95 px-4 py-3 text-foreground shadow-2xl backdrop-blur-md">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          {isDownloaded ? <RotateCwIcon className="size-4" /> : <DownloadIcon className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {isDownloaded ? `Sparky ${version} is ready` : `Sparky ${version} is available`}
          </p>
          <p className="text-xs text-muted-foreground">
            {isDownloading
              ? `Downloading${typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "…"}`
              : isDownloaded
                ? "Restart Sparky to install the update."
                : "Get the latest fixes and improvements."}
          </p>
        </div>
        {!isDownloading && (
          <Button size="sm" onClick={runAction}>
            {isDownloaded ? "Restart to update" : "Download update"}
          </Button>
        )}
        {!isDownloaded && (
          <Button
            aria-label="Dismiss update notification"
            size="icon-xs"
            variant="ghost"
            onClick={() => setDismissedVersion(version)}
          >
            <XIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
