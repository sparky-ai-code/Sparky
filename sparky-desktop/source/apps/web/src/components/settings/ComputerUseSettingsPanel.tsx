import { useEffect, useState } from "react";
import { MousePointer2Icon, SaveIcon } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function ComputerUseSettingsPanel() {
  const { computerUse } = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [instructions, setInstructions] = useState(computerUse.customInstructions);
  const [themeId, setThemeId] = useState(computerUse.cursorThemeId);

  useEffect(() => setInstructions(computerUse.customInstructions), [computerUse.customInstructions]);
  useEffect(() => setThemeId(computerUse.cursorThemeId), [computerUse.cursorThemeId]);

  const saveInstructions = () =>
    updateSettings({ computerUse: { customInstructions: instructions.trim() } });
  const saveThemeId = () => {
    const nextThemeId = themeId.trim() || "cua.default";
    setThemeId(nextThemeId);
    updateSettings({ computerUse: { cursorThemeId: nextThemeId } });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Computer use" icon={<MousePointer2Icon className="size-3.5" />}>
        <SettingsRow
          title="Allow computer use"
          description="Let Sparky interact with the computer running this desktop app. This is disabled by default."
          control={
            <Switch
              checked={computerUse.enabled}
              onCheckedChange={(checked) =>
                updateSettings({ computerUse: { enabled: Boolean(checked) } })
              }
              aria-label="Allow computer use on this computer"
            />
          }
        />
        <SettingsRow
          title="Cursor theme ID"
          description="Select an already-installed CUADriver theme. Custom theme upload requires a trusted host API that is still under upstream review."
        >
          <div className="space-y-3 pb-4">
            <input
              aria-label="Cursor theme ID"
              className="mt-3 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
              maxLength={128}
              placeholder="cua.default"
              value={themeId}
              onChange={(event) => setThemeId(event.currentTarget.value)}
              onBlur={saveThemeId}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Computer-use instructions"
          description="Additional guidance for Sparky when using computer-use tools."
        >
          <div className="space-y-3 pb-4">
            <Textarea
              aria-label="Computer-use instructions"
              className="mt-3"
              maxLength={12_000}
              placeholder="Example: Ask before submitting forms or sending messages."
              rows={8}
              value={instructions}
              onChange={(event) => setInstructions(event.currentTarget.value)}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {instructions.length.toLocaleString()} / 12,000 characters
              </span>
              <Button
                size="sm"
                disabled={instructions.trim() === computerUse.customInstructions}
                onClick={saveInstructions}
              >
                <SaveIcon className="size-3.5" />
                Save instructions
              </Button>
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
