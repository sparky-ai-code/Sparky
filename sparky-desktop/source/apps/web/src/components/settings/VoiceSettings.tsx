import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { KITTEN_VOICES } from "../../voice/kittenVoices";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function VoiceSettingsPanel() {
  const { voiceSelection, voiceSpeed } = useClientSettings();
  const update = useUpdateClientSettings();

  return (
    <SettingsPageContainer className="max-w-2xl gap-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Voice</h1>
        <p className="text-sm text-muted-foreground">
          Kitten TTS reads Sparky’s replies aloud on this device. Your selected AI model still
          handles the conversation and tools.
        </p>
      </div>
      <SettingsSection title="Voice calls">
        <SettingsRow
          title="Voice"
          description="Choose the voice for spoken replies."
          control={
            <div role="radiogroup" aria-label="Voice" className="grid max-w-md grid-cols-2 gap-1 rounded-lg border p-1">
              {KITTEN_VOICES.map((voice) => (
                <button
                  key={voice.key}
                  type="button"
                  role="radio"
                  aria-checked={voiceSelection === voice.key}
                  onClick={() => update({ voiceSelection: voice.key })}
                  className={
                    voiceSelection === voice.key
                      ? "rounded-md bg-primary px-3 py-2 text-left text-xs font-medium text-primary-foreground"
                      : "rounded-md px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted"
                  }
                >
                  <span className="block font-medium">{voice.name}</span>
                  <span className="block opacity-80">{voice.description}</span>
                </button>
              ))}
            </div>
          }
        />
        <SettingsRow
          title="Speaking speed"
          description="Adjust how quickly Kitten TTS speaks."
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
