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
        setImageMessage("Guest image installed. You can now create a new box.");
      } else {
        // Surface only the server's sanitized product error, never a raw host exception.
        const cause = squashAtomCommandFailure(result);
        setImageMessage(Schema.is(MicroboxError)(cause)
          ? cause.message
          : "Couldn't install the guest image. Extract the ZIP, select the folder containing image.json and rootfs.ext2, and destroy older boxes before replacing their image.");
      }
    } catch {
      setImageMessage("Couldn't install the image. Ensure the ZIP is extracted, the old box is destroyed, and there is enough free space.");
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
          description="Extract the Linux guest ZIP first, then select the folder containing image.json and rootfs.ext2. The image needs roughly 1 GiB more storage after extraction. Destroy existing boxes using the old image before replacing it."
        >
          <div className="flex flex-col items-end gap-2 pb-4">
            <Button
              size="sm"
              disabled={!settings.microboxesEnabled || installingImage || !environmentId}
              onClick={() => void handleImportImage()}
            >
              {installingImage ? "Installing guest image…" : "Install guest image from folder"}
            </Button>
            {imageMessage ? <p role={imageMessage.startsWith("Guest image installed") ? "status" : "alert"} className="max-w-md text-right text-xs text-muted-foreground">{imageMessage}</p> : null}
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
