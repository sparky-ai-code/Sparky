import { Monitor, Settings2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { MicroboxesSetupControl } from "./MicroboxesSetupControl";

/** Browser-style surface foundation. The guest desktop viewer is deliberately not simulated. */
export function MicroboxesPanel({ enabled, boxId }: { enabled: boolean; boxId: string | null }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Monitor className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{boxId ? `Box ${boxId}` : "Sparky Microboxes"}</span>
        </div>
        <Link to="/settings/microboxes" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <Settings2 className="size-3.5" /> Settings
        </Link>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl border bg-muted/30">
          <Monitor className="size-7 text-muted-foreground" />
        </div>
        <div className="max-w-sm space-y-1">
          <h3 className="text-sm font-semibold">No graphical box is connected</h3>
          <p className="text-xs text-muted-foreground">
            {enabled
              ? "The Microboxes host setup is available now. Guest images, virtual machine creation, and live GUI control are still being implemented."
              : "Enable Sparky Microboxes in settings before using a graphical box."}
          </p>
        </div>
        {enabled ? <MicroboxesSetupControl enabled /> : (
          <Link to="/settings/microboxes" className="text-xs text-primary underline underline-offset-4">
            Open Microboxes settings
          </Link>
        )}
      </div>
    </div>
  );
}
