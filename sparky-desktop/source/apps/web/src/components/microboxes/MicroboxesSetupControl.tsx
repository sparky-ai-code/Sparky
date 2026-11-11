import { useEffect, useState } from "react";
import type { DesktopMicroboxesSetupState } from "@sparky/contracts";
import { Button } from "../ui/button";

export function MicroboxesSetupControl({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<DesktopMicroboxesSetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.desktopBridge?.microboxes;

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    void bridge.getSetupState().then(
      (next) => {
        if (!disposed) setState(next);
      },
      () => {
        if (!disposed) setError("Couldn't check Sparky Microboxes on this device.");
      },
    );
    return () => {
      disposed = true;
    };
  }, [bridge]);

  if (!bridge) {
    return (
      <p className="text-xs text-muted-foreground">
        Sparky Microboxes setup is available in the desktop app.
      </p>
    );
  }
  const installing = busy || state?.status === "installing";
  const installed = state?.status === "engine-ready";
  const unsupported = state?.status === "unsupported";

  const handleSetup = async () => {
    setBusy(true);
    setError(null);
    try {
      // The actual approval dialog is in Electron's privileged main process.
      const result = await bridge.setup();
      setState(result);
    } catch {
      setError("Couldn't finish setting up Sparky Microboxes. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <Button
        size="sm"
        disabled={!enabled || installing || installed || unsupported}
        onClick={() => void handleSetup()}
      >
        {installing
          ? "Setting up Sparky Microboxes…"
          : installed
            ? "Microboxes components installed"
            : "Set up Sparky Microboxes"}
      </Button>
      {state?.detail ? <p className="max-w-sm text-xs text-muted-foreground">{state.detail}</p> : null}
      {error ? <p role="alert" className="max-w-sm text-xs text-destructive">{error}</p> : null}
      {!enabled ? (
        <p className="text-xs text-muted-foreground">Enable Microboxes to start setup.</p>
      ) : null}
    </div>
  );
}
