import { useEffect, useState } from "react";
import { CopyIcon, ExternalLinkIcon, PanelsTopLeftIcon } from "lucide-react";
import { isCustomizationSafeMode, refreshCustomization, useCustomization } from "../../customization";

export function CustomizationHost() {
  const { customization } = useCustomization();
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let mounted = true;
    const load = () => {
      void refreshCustomization().catch((error: unknown) => {
        if (mounted) console.warn("Could not refresh Sparky customization.", error);
      });
    };
    load();
    const interval = setInterval(load, 3500);
    const visible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  // Safe mode is intentionally independent of the saved mod: it must remain
  // reachable even if an agent-generated stylesheet obscures core controls.
  if (isCustomizationSafeMode() || customization.panels.length === 0) return null;

  return (
    <aside data-sparky-mods className="fixed bottom-4 right-4 z-40 flex max-w-[min(22rem,calc(100vw-2rem))] flex-col items-end gap-2">
      {expanded ? (
        <div className="max-h-[min(70vh,36rem)] w-80 max-w-full overflow-y-auto rounded-xl border border-border bg-card p-3 text-card-foreground shadow-2xl">
          <p className="mb-3 text-xs font-semibold">Sparky mods · {customization.name}</p>
          {customization.panels.map((panel) => (
            <section className="mb-3 space-y-2 last:mb-0" key={panel.id}>
              <h2 className="text-sm font-semibold">{panel.title}</h2>
              {panel.description ? <p className="text-xs text-muted-foreground">{panel.description}</p> : null}
              <div className="flex flex-wrap gap-1.5">
                {panel.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs hover:bg-accent"
                    onClick={() => {
                      setFeedback("");
                      if (action.kind === "copy") {
                        void navigator.clipboard.writeText(action.value)
                          .then(() => setFeedback("Copied " + action.label))
                          .catch(() => setFeedback("Clipboard access was denied."));
                        return;
                      }
                      if (action.value.startsWith("/")) {
                        // Handle routes in the current app instead of opening another
                        // Electron window or exposing local HTTP endpoints.
                        if (window.desktopBridge) {
                          window.location.hash = "#" + action.value;
                        } else {
                          window.location.assign(action.value);
                        }
                      } else {
                        window.open(action.value, "_blank", "noopener,noreferrer");
                      }
                    }}
                  >
                    {action.kind === "copy" ? <CopyIcon className="size-3" /> : <ExternalLinkIcon className="size-3" />}
                    {action.label}
                  </button>
                ))}
              </div>
            </section>
          ))}
          {feedback ? <p role="status" className="text-xs text-muted-foreground">{feedback}</p> : null}
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-xs font-semibold text-card-foreground shadow-lg hover:bg-accent"
      >
        <PanelsTopLeftIcon className="size-4" />
        Mods ({customization.panels.length})
      </button>
    </aside>
  );
}
