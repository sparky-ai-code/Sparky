import { useEffect, useState } from "react";
import { DEFAULT_CUSTOMIZATION, parseCustomization } from "@sparky/shared/customization";
import { refreshCustomization, saveCustomization, useCustomization } from "../../customization";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

export function CustomizationEditor() {
  const current = useCustomization();
  const [source, setSource] = useState(() => JSON.stringify(DEFAULT_CUSTOMIZATION, null, 2));
  const [edited, setEdited] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void refreshCustomization(true).catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "Could not load the saved customization."),
    );
  }, []);
  useEffect(() => {
    if (!edited) setSource(JSON.stringify(current.customization, null, 2));
  }, [current, edited]);

  const apply = async (reset = false) => {
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      const next = reset ? DEFAULT_CUSTOMIZATION : parseCustomization(JSON.parse(source) as unknown);
      const result = await saveCustomization(next, reset ? "*" : current.revision || undefined);
      setSource(JSON.stringify(result.customization, null, 2));
      setEdited(false);
      setMessage(reset ? "Mods reset to the default appearance." : "Customization saved and applied.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save customization.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Agent customization">
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <p className="text-xs leading-5 text-muted-foreground">
          Ask Sparky to restyle its own interface, create layouts and add quick-action
          panels. Its agent can read and apply these mods directly. Advanced edits can
          also be made here as declarative JSON. Styles and panels survive restarts.
        </p>
        <p className="break-all font-mono text-[11px] text-muted-foreground">
          {current.path || "Loading customization file…"}
        </p>
        <label htmlFor="sparky-customization-json" className="block text-xs font-semibold">
          Customization manifest
        </label>
        <textarea
          id="sparky-customization-json"
          spellCheck={false}
          aria-label="Customization manifest JSON"
          value={source}
          onChange={(event) => { setSource(event.target.value); setEdited(true); setMessage(""); }}
          rows={12}
          className="w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={saving} onClick={() => { void apply(); }}>
            Apply mod
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => { void apply(true); }}>
            Reset mods
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => {
            setEdited(false); setSource(JSON.stringify(current.customization, null, 2)); setMessage("");
          }}>
            Discard edits
          </Button>
        </div>
        {current.error ? <p role="alert" className="text-xs text-destructive">Saved mod error: {current.error}. Use Reset mods to recover.</p> : null}
        {message ? <p role="status" className="text-xs text-muted-foreground">{message}</p> : null}
        <p className="text-[11px] text-muted-foreground">
          Recovery: add <code>?safe-ui=1</code> to the app URL to disable custom styling temporarily.
          Mods do not execute arbitrary JavaScript or change app permissions.
        </p>
      </div>
    </SettingsSection>
  );
}
