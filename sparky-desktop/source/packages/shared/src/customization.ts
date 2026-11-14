/**
 * Sparky UI mods are declarative. The agent can change design tokens, CSS and
 * user-invoked panels without executing JavaScript in the renderer.
 */
export interface CustomizationAction {
  id: string;
  label: string;
  kind: "url" | "copy";
  value: string;
}

export interface CustomizationPanel {
  id: string;
  title: string;
  description: string;
  actions: CustomizationAction[];
}

export interface SparkyCustomization {
  version: 1;
  name: string;
  tokens: Record<string, string>;
  css: string;
  panels: CustomizationPanel[];
}

export const DEFAULT_CUSTOMIZATION: SparkyCustomization = {
  version: 1,
  name: "Sparky",
  tokens: {},
  css: "",
  panels: [],
};

export const MAX_CUSTOMIZATION_BYTES = 64 * 1024;

const TOKEN_NAMES = new Set([
  "--background", "--foreground", "--card", "--card-foreground",
  "--popover", "--popover-foreground", "--primary", "--primary-foreground",
  "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
  "--accent", "--accent-foreground", "--border", "--input", "--ring",
  "--destructive", "--success", "--warning", "--info", "--radius",
]);
const VALID_ID = /^[a-z][a-z0-9-]{0,39}$/;
const VALID_VALUE = /^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([^;{}\\<>]*\)|var\(--[a-z0-9-]+\)|transparent|currentColor|white|black|[0-9.]+(?:px|rem|%))$/i;
// Never allow stylesheet fetches or CSS escapes. CSS may still customize layout,
// animations and gradients; the user can always recover with ?safe-ui=1.
const UNSAFE_CSS = /@import\b|@font-face\b|@namespace\b|\burl\s*\(|image-set\s*\(|\bexpression\s*\(|-moz-binding|behavior\s*:|\\|\/\*|\*\/|[<>]/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || value.length > limit) {
    throw new Error(name + " must be a string of at most " + limit + " characters.");
  }
  return value;
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !VALID_ID.test(value)) {
    throw new Error(name + " must use lowercase letters, digits and hyphens.");
  }
  return value;
}

function actionUrl(value: string): boolean {
  if (/[\s\\]/.test(value)) return false;
  if (value.startsWith("/")) {
    return !value.startsWith("//") && !value.includes("..") &&
      /^\/(?:$|settings(?:\/|$)|plugins(?:\/|$)|pull-requests(?:\/|$)|schedules(?:\/|$))/.test(value);
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) &&
      parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

export function parseCustomization(input: unknown): SparkyCustomization {
  if (!record(input)) throw new Error("Customization must be a JSON object.");
  if (input.version !== 1) throw new Error("Unsupported customization version.");
  const name = text(input.name, "Theme name", 80).trim() || "Untitled";
  if (!record(input.tokens)) throw new Error("tokens must be an object.");
  if (Object.keys(input.tokens).length > TOKEN_NAMES.size) {
    throw new Error("Too many design token overrides.");
  }
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.tokens)) {
    if (!TOKEN_NAMES.has(key)) throw new Error("Unsupported design token: " + key);
    const colorOrSize = text(value, key, 120).trim();
    if (!VALID_VALUE.test(colorOrSize) ||
      (key === "--radius" && !/^[0-9.]+(?:px|rem)$/.test(colorOrSize))) {
      throw new Error("Invalid CSS design token: " + key);
    }
    tokens[key] = colorOrSize;
  }
  const css = text(input.css, "Custom CSS", 24_000);
  if (UNSAFE_CSS.test(css)) {
    throw new Error("Custom CSS cannot load remote resources, use CSS escapes or contain HTML.");
  }
  if (!Array.isArray(input.panels) || input.panels.length > 8) {
    throw new Error("panels must be a list of at most 8 panels.");
  }
  const ids = new Set<string>();
  const panels = input.panels.map((rawPanel, index): CustomizationPanel => {
    if (!record(rawPanel)) throw new Error("Panel " + index + " must be an object.");
    const panelId = id(rawPanel.id, "Panel ID");
    if (ids.has(panelId)) throw new Error("Duplicate panel ID: " + panelId);
    ids.add(panelId);
    const title = text(rawPanel.title, "Panel title", 80);
    const description = text(rawPanel.description, "Panel description", 1000);
    if (!Array.isArray(rawPanel.actions) || rawPanel.actions.length > 8) {
      throw new Error("Panel actions must be a list of at most 8 actions.");
    }
    const actionIds = new Set<string>();
    const actions = rawPanel.actions.map((rawAction, actionIndex): CustomizationAction => {
      if (!record(rawAction)) throw new Error("Action " + actionIndex + " must be an object.");
      const actionId = id(rawAction.id, "Action ID");
      if (actionIds.has(actionId)) throw new Error("Duplicate action ID: " + actionId);
      actionIds.add(actionId);
      if (rawAction.kind !== "url" && rawAction.kind !== "copy") {
        throw new Error("Action kind must be url or copy.");
      }
      const label = text(rawAction.label, "Action label", 64);
      const value = text(rawAction.value, "Action value", 2048);
      if (rawAction.kind === "url" && !actionUrl(value)) {
        throw new Error("Only HTTPS URLs and supported Sparky routes can be opened.");
      }
      return { id: actionId, kind: rawAction.kind, label, value };
    });
    return { id: panelId, title, description, actions };
  });
  const result: SparkyCustomization = { version: 1, name, tokens, css, panels };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_CUSTOMIZATION_BYTES) {
    throw new Error("Customization exceeds the 64 KiB size limit.");
  }
  return result;
}

export function customizationCss(value: SparkyCustomization): string {
  const tokens = Object.entries(value.tokens)
    .map(([key, cssValue]) => key + ": " + cssValue + " !important;")
    .join("\n");
  return (tokens ? ":root {\n" + tokens + "\n}\n" : "") + value.css;
}
