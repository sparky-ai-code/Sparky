import { useEffect, useState } from "react";
import { CloudIcon, SaveIcon } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const USE_CASE_OPTIONS = [
  "Build new products",
  "Improve an existing codebase",
  "Learn and explore code",
  "Automate engineering work",
] as const;

export function InstructionsSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [instructions, setInstructions] = useState(settings.customInstructions);

  useEffect(() => setInstructions(settings.customInstructions), [settings.customInstructions]);

  const trimmedInstructions = instructions.trim();
  const isDirty = trimmedInstructions !== settings.customInstructions;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Custom instructions">
        <SettingsRow
          title="How Sparky should work with you"
          description="These instructions are appended to Sparky's built-in system prompt for every coding turn."
        >
          <div className="space-y-3 pb-4">
            <Textarea
              aria-label="Custom instructions"
              className="mt-3"
              maxLength={12_000}
              placeholder="Example: Prefer TypeScript, keep changes small, run focused tests, and explain important tradeoffs."
              rows={10}
              value={instructions}
              onChange={(event) => setInstructions(event.currentTarget.value)}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {instructions.length.toLocaleString()} / 12,000 characters
              </span>
              <Button
                size="sm"
                disabled={!isDirty}
                onClick={() => updateSettings({ customInstructions: trimmedInstructions })}
              >
                <SaveIcon className="size-3.5" />
                Save instructions
              </Button>
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Personalization and data" icon={<CloudIcon className="size-3.5" />}>
        <SettingsRow
          title="Primary use"
          description="Used to personalize onboarding and future Sparky improvements."
          control={
            <Select
              value={settings.onboardingUseCase}
              onValueChange={(value) => {
                if (value) updateSettings({ onboardingUseCase: value });
              }}
            >
              <SelectTrigger className="w-full sm:w-64" aria-label="Primary Sparky use">
                <SelectValue>{settings.onboardingUseCase || "Choose a use"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {USE_CASE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
