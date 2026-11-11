import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { MicroboxesSetupControl } from "../microboxes/MicroboxesSetupControl";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/** The server setting is authoritative; toggling it is not the same as installing host components. */
export function MicroboxesSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
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
          title="Host setup"
          description="Install the components needed to run Microboxes. Sparky handles setup after you approve it. Your operating system may request permission."
        >
          <div className="flex justify-end px-0 pb-4">
            <MicroboxesSetupControl enabled={settings.microboxesEnabled} />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Guest images"
          description="The custom lightweight graphical Linux image and installer-test guest images are being built separately. Host setup alone does not create a usable VM."
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
