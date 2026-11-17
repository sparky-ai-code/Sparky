import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function VoiceSettingsPanel() {
  const { voiceChoice, voiceSpeed } = useClientSettings();
  const update = useUpdateClientSettings();
  return (
    <SettingsPageContainer className="max-w-2xl gap-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Voice</h1>
        <p className="text-sm text-muted-foreground">
          Choose how Sparky reads your AI model’s responses during a call.
        </p>
      </div>
      <SettingsSection title="Speech">
        <SettingsRow
          title="Voice"
          description="Choose one of tiny-voca’s two English voices."
          control={
            <select
              aria-label="Voice"
              className="h-9 min-w-36 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              value={voiceChoice}
              onChange={(event) =>
                update({ voiceChoice: event.currentTarget.value as "F2" | "M2" })
              }
            >
              <option value="F2">F2 · Female</option>
              <option value="M2">M2 · Male</option>
            </select>
          }
        />
        <SettingsRow
          title="Speaking speed"
          description="Adjust playback speed without changing the AI model."
          control={
            <div className="flex items-center gap-3">
              <input
                aria-label="Speaking speed"
                type="range"
                min="0.7"
                max="1.4"
                step="0.05"
                className="w-40 accent-primary"
                value={voiceSpeed}
                onChange={(event) => update({ voiceSpeed: Number(event.currentTarget.value) })}
              />
              <span className="min-w-12 text-right font-mono text-sm tabular-nums">
                {voiceSpeed.toFixed(2)}×
              </span>
            </div>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
