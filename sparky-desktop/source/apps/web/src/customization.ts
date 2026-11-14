import { useSyncExternalStore } from "react";
import {
  customizationCss,
  DEFAULT_CUSTOMIZATION,
  parseCustomization,
  type SparkyCustomization,
} from "@sparky/shared/customization";
import { fetchPrimaryEnvironment } from "./environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary/target";

export interface CustomizationSnapshot {
  readonly customization: SparkyCustomization;
  readonly revision: string;
  readonly path: string;
  readonly error?: string;
}

const EMPTY: CustomizationSnapshot = {
  customization: DEFAULT_CUSTOMIZATION, revision: "", path: "",
};
const STYLE_ID = "sparky-user-customization";
const listeners = new Set<() => void>();
let snapshot = EMPTY;
let appliedKey = "";
let lastLoadedAt = 0;
let inflight: Promise<CustomizationSnapshot> | null = null;

export function isCustomizationSafeMode(): boolean {
  return typeof window !== "undefined" &&
    new URLSearchParams(window.location.search || window.location.hash.split("?")[1] || "").get("safe-ui") === "1";
}

function updateStyle(next: SparkyCustomization): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (isCustomizationSafeMode()) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = customizationCss(next);
}

export function setCustomizationSnapshot(next: CustomizationSnapshot): void {
  const customization = parseCustomization(next.customization);
  const normalized: CustomizationSnapshot = { ...next, customization };
  const key = JSON.stringify(normalized);
  if (key === appliedKey) return;
  // Render the stylesheet before notifying React. An invalid response never
  // replaces the user's last valid customization.
  updateStyle(customization);
  snapshot = normalized;
  appliedKey = key;
  for (const listener of listeners) listener();
}

async function requestCustomization(input?: {
  customization: SparkyCustomization;
  expectedRevision?: string;
}): Promise<CustomizationSnapshot> {
  const response = await fetchPrimaryEnvironment(
    resolvePrimaryEnvironmentHttpUrl("/api/sparky/customization"),
    input === undefined
      ? { method: "GET", cache: "no-store" }
      : { method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify(input) },
  );
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload &&
      typeof payload.error === "string" ? payload.error : "Customization request failed.";
    throw new Error(message);
  }
  if (typeof payload !== "object" || payload === null || !("customization" in payload) ||
    !("revision" in payload) || typeof payload.revision !== "string") {
    throw new Error("The customization server returned an invalid response.");
  }
  return payload as CustomizationSnapshot;
}

export function refreshCustomization(force = false): Promise<CustomizationSnapshot> {
  if (inflight) return inflight;
  // Polling is a fallback for edits made by the agent and other app windows.
  if (!force && Date.now() - lastLoadedAt < 1500 && snapshot.revision) {
    return Promise.resolve(snapshot);
  }
  inflight = requestCustomization().then((next) => {
    lastLoadedAt = Date.now();
    setCustomizationSnapshot(next);
    return next;
  }).finally(() => { inflight = null; });
  return inflight;
}

export async function saveCustomization(
  customization: SparkyCustomization,
  expectedRevision?: string,
): Promise<CustomizationSnapshot> {
  const next = await requestCustomization({ customization: parseCustomization(customization), expectedRevision });
  lastLoadedAt = Date.now();
  setCustomizationSnapshot(next);
  return next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCustomization(): CustomizationSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

export function resetCustomizationForTests(): void {
  snapshot = EMPTY;
  appliedKey = "";
  lastLoadedAt = 0;
  updateStyle(DEFAULT_CUSTOMIZATION);
}
