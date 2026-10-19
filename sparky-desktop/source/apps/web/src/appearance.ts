export const APPEARANCE_THEMES = [
  { id: "default", name: "Sparky", accent: "#f5f5f5", hue: "0 0% 96%" },
  { id: "ocean", name: "Ocean", accent: "#38bdf8", hue: "199 89% 48%" },
  { id: "forest", name: "Forest", accent: "#4ade80", hue: "142 71% 45%" },
  { id: "violet", name: "Violet", accent: "#a78bfa", hue: "258 90% 66%" },
  { id: "rose", name: "Rose", accent: "#fb7185", hue: "350 89% 60%" },
  { id: "amber", name: "Amber", accent: "#fbbf24", hue: "43 96% 56%" },
] as const;

type ThemeId = (typeof APPEARANCE_THEMES)[number]["id"];
export type AppearancePreferences = {
  theme: ThemeId;
  compact: boolean;
  customColor: string | null;
  hoverStyle: "subtle" | "colorful";
  roundedness: "soft" | "rounded" | "sharp";
};

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: "default",
  compact: false,
  customColor: null,
  hoverStyle: "colorful",
  roundedness: "rounded",
};

const STORAGE_KEY = "sparky-appearance";

export function readAppearance(): AppearancePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<AppearancePreferences> | null;
    return {
      theme: APPEARANCE_THEMES.some((item) => item.id === value?.theme) ? (value!.theme as ThemeId) : "default",
      compact: value?.compact === true,
      customColor: typeof value?.customColor === "string" && /^#[0-9a-f]{6}$/i.test(value.customColor) ? value.customColor : null,
      hoverStyle: value?.hoverStyle === "subtle" ? "subtle" : "colorful",
      roundedness: value?.roundedness === "soft" || value?.roundedness === "sharp" ? value.roundedness : "rounded",
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function applyAppearance(preferences: AppearancePreferences) {
  const selected = APPEARANCE_THEMES.find((item) => item.id === preferences.theme) ?? APPEARANCE_THEMES[0];
  const color = preferences.customColor ?? `hsl(${selected.hue})`;
  const root = document.documentElement;
  const isDefaultTheme = !preferences.customColor && preferences.theme === "default";
  if (isDefaultTheme) {
    // Let the base theme resolve primary to foreground so black/white controls follow color mode.
    root.style.removeProperty("--primary");
    root.style.removeProperty("--ring");
    root.style.setProperty("--accent", `color-mix(in srgb, var(--foreground) ${preferences.hoverStyle === "colorful" ? "18%" : "7%"}, transparent)`);
  } else {
    // These theme tokens are CSS <color> values, not HSL channel tuples.
    root.style.setProperty("--primary", color);
    root.style.setProperty("--ring", color);
    root.style.setProperty("--accent", `color-mix(in srgb, ${color} ${preferences.hoverStyle === "colorful" ? "18%" : "7%"}, transparent)`);
  }
  root.style.setProperty("--radius", preferences.roundedness === "soft" ? "0.9rem" : preferences.roundedness === "sharp" ? "0.35rem" : "0.625rem");
  root.dataset.appearance = preferences.customColor ? "custom" : preferences.theme;
  root.dataset.density = preferences.compact ? "compact" : "comfortable";
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // The active appearance still applies for this session when storage is unavailable.
  }
}

export function syncSavedAppearance() {
  applyAppearance(readAppearance());
}
