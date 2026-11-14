import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { DesktopMicroboxesSetupState } from "@sparky/contracts";

/** Provision automatically after the user explicitly enables Microboxes. */
export function MicroboxesSetupControl({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<DesktopMicroboxesSetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);
  const bridge = window.desktopBridge?.microboxes;

  useEffect(() => {
    if (!bridge || !enabled) {
      attempted.current = false;
      return;
    }
    let active = true;
    const run = async () => {
      setBusy(true);
      setError(null);
      try {
        const initial = await bridge.getSetupState();
        if (!active) return;
        setState(initial);
        if (initial.status === "engine-ready" || initial.status === "unsupported") return;
        if (attempted.current) return;
        attempted.current = true;
        const result = await bridge.setup();
        if (active) setState(result);
      } catch {
        if (active) setError("Couldn't install the required Microboxes components.");
      } finally {
        if (active) setBusy(false);
      }
    };
    void run();
    return () => { active = false; };
  }, [bridge, enabled]);

  if (!enabled) return null;
  if (!bridge) {
    return <p role="status" className="text-xs text-muted-foreground">Microboxes require the desktop app.</p>;
  }
  if (busy || !state || state.status === "installing") {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        Installing requirements…
      </div>
    );
  }
  if (error || state.status === "error" || state.status === "unsupported") {
    return (
      <p role="alert" className="text-xs text-destructive">
        {error ?? state.detail ?? "Automatic Microboxes setup isn't supported on this device."}
      </p>
    );
  }
  return <p role="status" className="text-xs text-muted-foreground">Requirements ready</p>;
}
