import { useEffect, useState } from "react";
import { DEFAULT_CUSTOMIZATION, parseCustomization } from "@sparky/shared/customization";
import { refreshCustomization, saveCustomization, useCustomization } from "../../customization";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

export function CustomizationEditor() {
  const current = useCustomization();
  const [source, setSource] = useState(() => JSON.stringify(DEFAULT_CUSTOMIZATION, null, 2));
  const [baseRevision, setBaseRevision] = useState("");
  const [edited, setEdited] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    void refreshCustomization(true).catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "Could not load your mods."),
    );
  }, []);
  useEffect(() => {
    if (edited) return;
    setSource(JSON.stringify(current.customization, null, 2));
    setBaseRevision(current.revision);
  }, [current, edited]);

  const apply = async (reset = false) => {
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      const next = reset ? DEFAULT_CUSTOMIZATION : parseCustomization(JSON.parse(source) as unknown);
      // Keep the revision from when editing started. An agent change made
      // while this editor is open must not be silently overwritten.
      const result = await saveCustomization(next, reset ? "*" : baseRevision);
      setSource(JSON.stringify(result.customization, null, 2));
      setBaseRevision(result.revision);
      setEdited(false);
      setConfirmReset(false);
      setMessage(reset ? "Mods reset to the default appearance." : "Changes saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save your mods.");
    } finally {
      setSaving(false);
    }
  };

  const hasMods = current.error !== undefined ||
    JSON.stringify(current.customization) !== JSON.stringify(DEFAULT_CUSTOMIZATION);

  return (
    <SettingsSection title="Sparky mods">
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {hasMods ? current.customization.name : "Default appearance"}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              Ask Sparky to change its theme, layout or quick actions. Changes apply automatically
              and stay after restarting.
            </p>
          </div>
          {hasMods && !confirmReset ? (
            <Button type="button" size="sm" variant="outline" disabled={saving}
              onClick={() => setConfirmReset(true)}>Reset mods</Button>
          ) : null}
        </div>

        {current.error ? (
          <p role="alert" className="text-xs text-destructive">
            Saved mods could not be loaded: {current.error}. You can reset them below.
          </p>
        ) : null}
        {confirmReset ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
            <p className="min-w-0 flex-1 text-xs">Remove all custom styles and panels?</p>
            <Button type="button" size="sm" variant="destructive" disabled={saving}
              onClick={() => { void apply(true); }}>Confirm reset</Button>
            <Button type="button" size="sm" variant="ghost" disabled={saving}
              onClick={() => setConfirmReset(false)}>Cancel</Button>
          </div>
        ) : null}

        <details className="group rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium">
            Advanced: edit mod JSON
          </summary>
          <div className="space-y-3 border-t border-border p-3">
            <label htmlFor="sparky-customization-json" className="block text-xs text-muted-foreground">
              Customization manifest
            </label>
            <textarea
              id="sparky-customization-json"
              spellCheck={false}
              value={source}
              onChange={(event) => {
                if (!edited) setBaseRevision(current.revision);
                setSource(event.target.value);
                setEdited(true);
                setMessage("");
              }}
              rows={10}
              className="w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={saving || !edited}
                onClick={() => { void apply(); }}>Save changes</Button>
              {edited ? (
                <Button type="button" size="sm" variant="ghost" disabled={saving}
                  onClick={() => {
                    setEdited(false);
                    setSource(JSON.stringify(current.customization, null, 2));
                    setBaseRevision(current.revision);
                    setMessage("");
                  }}>Discard edits</Button>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Custom styles and panels cannot run JavaScript or change app permissions.
              If the interface becomes unreadable, use <code>?safe-ui=1</code> to temporarily
              disable mods, then reset them here.
            </p>
          </div>
        </details>
        {message ? <p role="status" className="text-xs text-muted-foreground">{message}</p> : null}
      </div>
    </SettingsSection>
  );
}
