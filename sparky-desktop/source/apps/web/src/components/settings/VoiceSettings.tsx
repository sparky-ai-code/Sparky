import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function VoiceSettingsPanel() {
  const { voiceSelection, voiceSpeed } = useClientSettings();
  const update = useUpdateClientSettings();

  return (
    <SettingsPageContainer className="max-w-2xl gap-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Voice</h1>
        <p className="text-sm text-muted-foreground">
          Tiny Voca reads Sparky’s responses aloud. Your existing AI model continues to handle
          conversations and tools.
        </p>
      </div>
      <SettingsSection title="Voice calls">
        <SettingsRow
          title="Voice"
          description="Choose the voice for spoken responses."
          control={
            <div role="group" aria-label="Voice" className="flex gap-1 rounded-lg border p-1">
              {(["F2", "M2"] as const).map((voice) => (
                <button
                  key={voice}
                  type="button"
                  aria-pressed={voiceSelection === voice}
                  onClick={() => update({ voiceSelection: voice })}
                  className={
                    voiceSelection === voice
                      ? "rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
                      : "rounded-md px-4 py-2 text-xs text-muted-foreground hover:bg-muted"
                  }
                >
                  {voice === "F2" ? "Female" : "Male"}
                </button>
              ))}
            </div>
          }
        />
        <SettingsRow
          title="Speaking speed"
          description="Adjust how quickly Tiny Voca speaks."
          control={
            <label className="flex items-center gap-3">
              <input
                aria-label="Speaking speed"
                type="range"
                min={0.7}
                max={1.4}
                step={0.05}
                value={voiceSpeed}
                onChange={(event) => update({ voiceSpeed: Number(event.currentTarget.value) })}
                className="w-32 accent-primary"
              />
              <span className="w-12 text-right font-mono text-xs tabular-nums">
                {voiceSpeed.toFixed(2)}×
              </span>
            </label>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
