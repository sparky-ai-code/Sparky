import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { MicroboxesSetupControl } from "../microboxes/MicroboxesSetupControl";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/** The opt-in switch starts provisioning; no separate setup or image buttons. */
export function MicroboxesSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Sparky Microboxes">
        <SettingsRow
          title="Enable Microboxes"
          description="Let Sparky use an isolated Linux desktop. Setup and guest images are handled automatically."
          control={
            <Switch
              checked={settings.microboxesEnabled}
              onCheckedChange={(checked) => updateSettings({ microboxesEnabled: Boolean(checked) })}
              aria-label="Enable Sparky Microboxes"
            />
          }
        />
        {settings.microboxesEnabled ? (
          <>
            <SettingsRow
              title="Internet access"
              description="Off by default. Allow new boxes to connect to external networks when Sparky needs to."
              control={
                <Switch
                  checked={settings.microboxesInternetEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ microboxesInternetEnabled: Boolean(checked) })
                  }
                  aria-label="Allow Microboxes internet access"
                />
              }
            />
            <div className="px-1 py-3">
              <MicroboxesSetupControl enabled />
            </div>
          </>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
