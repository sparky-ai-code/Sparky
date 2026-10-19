import { useEffect, useState } from "react";
import { CheckIcon, RotateCcwIcon } from "lucide-react";

import { useTheme } from "../../hooks/useTheme";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const STORAGE_KEY = "sparky-appearance";
const THEMES = [
  { id: "default", name: "Sparky", accent: "#f5f5f5", hue: "0 0% 96%" },
  { id: "ocean", name: "Ocean", accent: "#38bdf8", hue: "199 89% 48%" },
  { id: "forest", name: "Forest", accent: "#4ade80", hue: "142 71% 45%" },
  { id: "violet", name: "Violet", accent: "#a78bfa", hue: "258 90% 66%" },
  { id: "rose", name: "Rose", accent: "#fb7185", hue: "350 89% 60%" },
  { id: "amber", name: "Amber", accent: "#fbbf24", hue: "43 96% 56%" },
] as const;
type ThemeId = (typeof THEMES)[number]["id"];

function readAppearance(): { theme: ThemeId; compact: boolean; customColor: string | null } {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { theme?: string; compact?: boolean } | null;
    return {
      theme: THEMES.some((item) => item.id === value?.theme) ? (value!.theme as ThemeId) : "default",
      compact: value?.compact === true,
      customColor: typeof (value as { customColor?: unknown } | null)?.customColor === "string" ? (value as { customColor: string }).customColor : null,
    };
  } catch {
    return { theme: "default", compact: false, customColor: null };
  }
}

function applyAppearance(theme: ThemeId, compact: boolean, customColor: string | null) {
  const selected = THEMES.find((item) => item.id === theme) ?? THEMES[0];
  const color = customColor ?? `hsl(${selected.hue})`;
  document.documentElement.style.setProperty("--primary", color);
  document.documentElement.style.setProperty("--ring", color);
  document.documentElement.dataset.appearance = customColor ? "custom" : theme;
  document.documentElement.dataset.density = compact ? "compact" : "comfortable";
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, compact, customColor }));
}

export function syncSavedAppearance() {
  const saved = readAppearance();
  applyAppearance(saved.theme, saved.compact, saved.customColor);
}

export function AppearanceSettingsPanel() {
  const { theme: mode, setTheme: setMode } = useTheme();
  const [appearance, setAppearance] = useState(readAppearance);
  useEffect(() => applyAppearance(appearance.theme, appearance.compact, appearance.customColor), [appearance]);

  const update = (next: Partial<typeof appearance>) => {
    setAppearance((current) => ({ ...current, ...next }));
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Color theme">
        <SettingsRow title="Choose a palette" description="Change the accent color used throughout Sparky. Your choice is saved on this device.">
          <div className="grid grid-cols-2 gap-3 py-4 sm:grid-cols-3">
            {THEMES.map((item) => {
              const selected = appearance.theme === item.id;
              return (
                <button key={item.id} type="button" aria-pressed={selected} onClick={() => update({ theme: item.id, customColor: null })}
                  className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-accent/50 ${selected ? "border-primary bg-accent/30" : "border-border"}`}>
                  <span className="grid size-9 place-items-center rounded-full" style={{ backgroundColor: item.accent }}>
                    {selected ? <CheckIcon className="size-4" style={{ color: item.id === "default" ? "#111" : "#fff" }} /> : null}
                  </span>
                  <span className="text-sm font-medium">{item.name}</span>
                </button>
              );
            })}
          </div>
        </SettingsRow>
        <SettingsRow title="Custom accent color" description="Pick any accent color to personalize buttons and highlights."
          control={<input aria-label="Custom accent color" type="color" value={appearance.customColor ?? (THEMES.find((item) => item.id === appearance.theme)?.accent ?? "#a78bfa")} onChange={(event) => update({ customColor: event.currentTarget.value })} className="size-10 cursor-pointer rounded-md border-0 bg-transparent" />} />
      </SettingsSection>
      <SettingsSection title="Display">
        <SettingsRow title="Color mode" description="Use light or dark colors, or follow your system preference."
          control={<select aria-label="Color mode" value={mode} onChange={(event) => setMode(event.currentTarget.value as "light" | "dark" | "system")} className="h-9 rounded-md border border-border bg-background px-3 text-sm">
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>} />
        <SettingsRow title="Compact layout" description="Tighten spacing in lists and settings for a denser workspace."
          control={<input aria-label="Compact layout" type="checkbox" checked={appearance.compact} onChange={(event) => update({ compact: event.currentTarget.checked })} className="size-4 accent-primary" />} />
      </SettingsSection>
      <div className="flex justify-end pb-6"><Button variant="outline" size="sm" onClick={() => { setMode("system"); update({ theme: "default", compact: false, customColor: null }); }}><RotateCcwIcon className="size-3.5" />Reset appearance</Button></div>
    </SettingsPageContainer>
  );
}
