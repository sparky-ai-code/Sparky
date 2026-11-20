import { useEffect, useRef } from "react";

const MAX_BACKOFF_MS = 60_000;

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Calls `run` immediately and then every `intervalMs` while enabled.
 *
 * - Pauses while the document is hidden and runs once when it becomes visible again.
 * - A run that is still pending blocks overlapping runs.
 * - Failures double the delay (capped at 60s). A success resets it to `intervalMs`.
 * - Errors are swallowed here. The caller owns its error state.
 * - Keeps no React state, so it never causes a re-render.
 * - Changing the `run` identity does not restart the timer.
 */
export function useTeamPolling(options: {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly run: () => Promise<unknown> | unknown;
}): void {
  const { enabled, intervalMs, run } = options;

  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let disposed = false;
    let inFlight = false;
    let delay = intervalMs;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (ms: number) => {
      clearTimer();
      if (disposed || isDocumentHidden()) {
        return;
      }
      timer = setTimeout(tick, ms);
    };

    const settle = (succeeded: boolean) => {
      inFlight = false;
      if (succeeded) {
        delay = intervalMs;
      } else {
        delay = Math.min(delay * 2, Math.max(MAX_BACKOFF_MS, intervalMs));
      }
      schedule(delay);
    };

    function tick() {
      timer = null;
      if (disposed || isDocumentHidden() || inFlight) {
        // A pending run reschedules itself when it settles.
        return;
      }
      inFlight = true;
      // Wrapping in a Promise turns synchronous throws into rejections.
      new Promise<unknown>((resolve) => resolve(runRef.current())).then(
        () => settle(true),
        () => settle(false),
      );
    }

    const onVisibilityChange = () => {
      clearTimer();
      if (!isDocumentHidden()) {
        tick();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    tick();

    return () => {
      disposed = true;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [enabled, intervalMs]);
}
