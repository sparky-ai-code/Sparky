import { DownloadIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { isElectron } from "../env";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateNoticeKey,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

// Notice keys the user dismissed with the X. Module-scoped so the dismissal
// survives the transient status changes that reset the component's own refs.
const dismissedDesktopUpdateNoticeKeys = new Set<string>();

export function DesktopUpdateBanner() {
  const state = useDesktopUpdateState();
  const lastNotification = useRef<{
    key: string;
    id: ReturnType<typeof toastManager.add>;
  } | null>(null);
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const version = state?.availableVersion ?? state?.downloadedVersion;

  const runAction = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !state || isDesktopUpdateButtonDisabled(state) || action === "none") return;

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (!result.completed && shouldToastDesktopUpdateActionResult(result)) {
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

  useEffect(() => {
    const notification = lastNotification.current;
    const key = isElectron ? getDesktopUpdateNoticeKey(state) : null;

    if (key === null || !state || !version) {
      if (notification) toastManager.close(notification.id);
      lastNotification.current = null;
      return;
    }

    if (notification?.key === key) return;
    if (notification) toastManager.close(notification.id);
    lastNotification.current = null;

    // The user already dismissed this exact notice. Background checks flip the
    // status through "checking" and back, which re-runs this effect, so the
    // dismissal has to be honored here or the popup returns right away.
    if (dismissedDesktopUpdateNoticeKeys.has(key)) return;

    const downloaded = state.status === "downloaded";
    const downloading = state.status === "downloading";
    const description = downloading
      ? `Downloading${typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "…"}`
      : downloaded
        ? "Restart Sparky to install the update."
        : "Get the latest fixes and improvements.";
    const id = toastManager.add(
      stackedThreadToast({
        type: "info",
        title: downloaded ? `Sparky ${version} is ready` : `Sparky ${version} is available`,
        description,
        timeout: 0,
        ...(downloading
          ? {}
          : {
              actionProps: {
                children: downloaded ? "Restart to update" : "Download update",
                onClick: runAction,
              },
            }),
        data: {
          leadingIcon: downloaded ? (
            <RotateCwIcon className="size-4" />
          ) : (
            <DownloadIcon className="size-4" />
          ),
          onClose: () => {
            dismissedDesktopUpdateNoticeKeys.add(key);
          },
        },
      }),
    );
    lastNotification.current = { key, id };
  }, [runAction, state, version]);

  return null;
}
