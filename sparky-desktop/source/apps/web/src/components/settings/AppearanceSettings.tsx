import { useEffect, useState } from "react";
import { CheckIcon, RotateCcwIcon } from "lucide-react";

import {
  APPEARANCE_THEMES as THEMES,
  applyAppearance,
  DEFAULT_APPEARANCE,
  readAppearance,
} from "../../appearance";
import { useTheme } from "../../hooks/useTheme";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const COLOR_MODE_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const HOVER_STYLE_OPTIONS = [
  { value: "colorful", label: "Colorful" },
  { value: "subtle", label: "Subtle" },
];
const CORNER_STYLE_OPTIONS = [
  { value: "soft", label: "Extra rounded" },
  { value: "rounded", label: "Rounded" },
  { value: "sharp", label: "Square" },
];

export function AppearanceSettingsPanel() {
  const { theme: mode, setTheme: setMode } = useTheme();
  const [appearance, setAppearance] = useState(readAppearance);
  useEffect(() => applyAppearance(appearance), [appearance]);

  const update = (next: Partial<typeof appearance>) => {
    setAppearance((current) => ({ ...current, ...next }));
  };

  return (
    <SettingsPageContainer className="max-w-2xl gap-5">
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Appearance</h1>
          <p className="text-sm text-muted-foreground">Colors, interaction, and spacing.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { setMode("system"); update({ ...DEFAULT_APPEARANCE }); }}>
          <RotateCcwIcon className="size-3.5" />Reset
        </Button>
      </header>
      <SettingsSection title="Color theme" className="space-y-2">
        <SettingsRow title="Accent palette" description="Choose the highlight color used across the interface." className="pt-2 pb-0">
          <div className="grid grid-cols-3 gap-1 py-2 sm:grid-cols-6">
            {THEMES.map((item) => {
              const selected = appearance.theme === item.id;
              return (
                <button key={item.id} type="button" aria-pressed={selected} onClick={() => update({ theme: item.id, customColor: null })}
                  className={`flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs transition-colors hover:bg-muted/60 ${selected ? "bg-accent/30 text-foreground" : "text-muted-foreground"}`}>
                  <span className={`grid size-6 place-items-center rounded-full ring-1 ring-border/60 ${selected ? "ring-2 ring-primary/70 ring-offset-2 ring-offset-card" : ""}`} style={{ backgroundColor: item.accent }}>
                    {selected ? <CheckIcon className="size-3" style={{ color: "#111" }} /> : null}
                  </span>
                  <span className="font-medium">{item.name}</span>
                </button>
              );
            })}
          </div>
        </SettingsRow>
        <SettingsRow title="Custom accent color" description="Pick any accent color to personalize buttons and highlights." className="py-2.5"
          control={<input aria-label="Custom accent color" type="color" value={appearance.customColor ?? (THEMES.find((item) => item.id === appearance.theme)?.accent ?? "#a78bfa")} onChange={(event) => update({ customColor: event.currentTarget.value })} className="size-8 cursor-pointer rounded-md border-0 bg-transparent" />} />
      </SettingsSection>
      <SettingsSection title="Display and interaction" className="space-y-2">
        <SettingsRow title="Color mode" description="Use light or dark colors, or follow your system preference." className="py-2.5"
          control={
            <Select value={mode} items={COLOR_MODE_OPTIONS} onValueChange={(value) => {
              if (value === "light" || value === "dark" || value === "system") setMode(value);
            }}>
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Color mode">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectPopup>
            </Select>
          } />
        <SettingsRow title="Hover highlight" description="Use your selected theme color for hover, focus, and highlighted menu states." className="py-2.5"
          control={
            <Select value={appearance.hoverStyle} items={HOVER_STYLE_OPTIONS} onValueChange={(value) => {
              if (value === "subtle" || value === "colorful") update({ hoverStyle: value });
            }}>
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Hover highlight style">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="colorful">Colorful</SelectItem>
                <SelectItem value="subtle">Subtle</SelectItem>
              </SelectPopup>
            </Select>
          } />
        <SettingsRow title="Interface corners" description="Adjust the shape of buttons, menus, and panels across Sparky." className="py-2.5"
          control={
            <Select value={appearance.roundedness} items={CORNER_STYLE_OPTIONS} onValueChange={(value) => {
              if (value === "soft" || value === "rounded" || value === "sharp") update({ roundedness: value });
            }}>
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Interface corner style">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="soft">Extra rounded</SelectItem>
                <SelectItem value="rounded">Rounded</SelectItem>
                <SelectItem value="sharp">Square</SelectItem>
              </SelectPopup>
            </Select>
          } />
        <SettingsRow title="Compact layout" description="Reduce spacing in settings and navigation for a denser workspace." className="py-2.5"
          control={<Switch aria-label="Compact layout" checked={appearance.compact} onCheckedChange={(checked) => update({ compact: checked })} />} />
      </SettingsSection>
      <div className="flex justify-end pb-6"><Button variant="outline" size="sm" onClick={() => { setMode("system"); update({ ...DEFAULT_APPEARANCE }); }}><RotateCcwIcon className="size-3.5" />Reset appearance</Button></div>
    </SettingsPageContainer>
  );
}
