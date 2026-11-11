import { useState } from "react";
import { MicroboxError } from "@sparky/contracts";
import { squashAtomCommandFailure } from "@sparky/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { microboxesEnvironment } from "../../state/microboxes";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { MicroboxesSetupControl } from "../microboxes/MicroboxesSetupControl";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/** The server setting is authoritative; toggling it is not the same as installing host components. */
export function MicroboxesSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const environmentId = usePrimaryEnvironment()?.environmentId;
  const importGuestImage = useAtomCommand(microboxesEnvironment.importImage, { reportFailure: false });
  const [installingImage, setInstallingImage] = useState(false);
  const [imageMessage, setImageMessage] = useState<string | null>(null);

  const handleImportImage = async () => {
    if (!environmentId || !window.desktopBridge?.pickFolder) return;
    const sourceDirectory = await window.desktopBridge.pickFolder();
    if (!sourceDirectory) return;
    setInstallingImage(true);
    setImageMessage(null);
    try {
      const result = await importGuestImage({ environmentId, input: { sourceDirectory } });
      if (result._tag === "Success") {
        setImageMessage("Guest image installed. You can now create a box.");
      } else {
        // Surface only the server's sanitized product error, never a raw host exception.
        const cause = squashAtomCommandFailure(result);
        setImageMessage(Schema.is(MicroboxError)(cause)
          ? cause.message
          : "Couldn't install the guest image. Check the selected folder and try again.");
      }
    } catch {
      setImageMessage("Couldn't install the guest image.");
    } finally {
      setInstallingImage(false);
    }
  };
  return (
    <SettingsPageContainer>
      <SettingsSection title="Sparky Microboxes">
        <SettingsRow
          title="Enable Microboxes"
          description="Allow Sparky to use isolated graphical virtual machines when this feature is available. Disabled by default."
          control={
            <Switch
              checked={settings.microboxesEnabled}
              onCheckedChange={(checked) => updateSettings({ microboxesEnabled: Boolean(checked) })}
              aria-label="Enable Sparky Microboxes"
            />
          }
        />
        <SettingsRow
          title="Allow guest internet"
          description="Disabled by default. Networked boxes can contact websites and other reachable networks; only enable this for test environments you trust."
          control={
            <Switch
              checked={settings.microboxesInternetEnabled}
              disabled={!settings.microboxesEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ microboxesInternetEnabled: Boolean(checked) })
              }
              aria-label="Allow Microboxes guest internet access"
            />
          }
        />
        <SettingsRow
          title="Host setup"
          description="Install the components needed to run Microboxes. Sparky handles setup after you approve it. Your operating system may request permission."
        >
          <div className="flex justify-end px-0 pb-4">
            <MicroboxesSetupControl enabled={settings.microboxesEnabled} />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Guest images"
          description="Install the graphical Linux guest image or a compatible installer-test guest image. Each image is kept separately from host files."
        >
          <div className="flex flex-col items-end gap-2 pb-4">
            <Button
              size="sm"
              disabled={!settings.microboxesEnabled || installingImage || !environmentId}
              onClick={() => void handleImportImage()}
            >
              {installingImage ? "Installing guest image…" : "Install guest image from folder"}
            </Button>
            {imageMessage ? <p role="status" className="text-xs text-muted-foreground">{imageMessage}</p> : null}
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
