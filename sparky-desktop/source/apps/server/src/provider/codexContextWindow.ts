// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Codex's OAuth app-server model/list response omits context metadata. The
 * local Codex model cache is the same catalog used by the runtime and carries
 * both the raw model window and the effective input budget percentage.
 *
 * The fallback is the current Codex OAuth catalog default (272k raw, 258.4k
 * effective at 95%), used only when the cache is unavailable or malformed.
 */
export const CODEX_OAUTH_FALLBACK_CONTEXT_WINDOW_TOKENS = 272_000;
export const CODEX_OAUTH_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;

export interface CodexOAuthContextWindow {
  /** Raw context value accepted by Codex's model_context_window setting. */
  readonly contextWindowTokens: number;
  /** Maximum raw value permitted by the OAuth model catalog. */
  readonly maxContextWindowTokens: number;
  /** Effective default input budget emitted by Codex runtime usage events. */
  readonly effectiveContextWindowTokens: number;
  /** Effective maximum input budget permitted by the catalog. */
  readonly maxEffectiveContextWindowTokens: number;
  readonly effectiveContextWindowPercent: number;
}

type CatalogEntry = Record<string, unknown>;
type CatalogCache = ReadonlyMap<string, CatalogEntry>;

const catalogCacheByPath = new Map<
  string,
  { readonly mtimeMs: number; readonly size: number; readonly entries: CatalogCache }
>();

export function isCodexOAuthModel(model: string | undefined): boolean {
  return typeof model === "string" && /^openai-codex\//u.test(model.trim());
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function positivePercentage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelSlug(model: string): string {
  return model.trim().replace(/^openai-codex\//u, "").replace(/^models\//u, "");
}

function resolveCodexHome(environment: NodeJS.ProcessEnv): string | undefined {
  const home = environment.USERPROFILE?.trim() || environment.HOME?.trim();
  const configured =
    environment.SPARKY_CODEX_HOME?.trim() || environment.CODEX_HOME?.trim() || undefined;
  return configured || (home ? NodePath.join(home, ".codex") : undefined);
}

function readCatalogEntries(path: string): CatalogCache {
  try {
    const stat = NodeFS.statSync(path);
    const cached = catalogCacheByPath.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.entries;
    }
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    const entries = new Map<string, CatalogEntry>();
    if (isRecord(parsed) && Array.isArray(parsed.models)) {
      for (const candidate of parsed.models) {
        if (!isRecord(candidate)) continue;
        const slug = typeof candidate.slug === "string" ? modelSlug(candidate.slug) : "";
        if (slug) entries.set(slug, candidate);
      }
    }
    catalogCacheByPath.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
    return entries;
  } catch {
    return new Map();
  }
}

export function readCodexOAuthContextWindow(
  model: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): CodexOAuthContextWindow | undefined {
  if (!isCodexOAuthModel(model)) return undefined;
  const codexHome = resolveCodexHome(environment);
  const entry = codexHome
    ? readCatalogEntries(NodePath.join(codexHome, "models_cache.json")).get(modelSlug(model ?? ""))
    : undefined;
  const contextWindowTokens =
    positiveInteger(entry?.context_window) ??
    positiveInteger(entry?.max_context_window) ??
    CODEX_OAUTH_FALLBACK_CONTEXT_WINDOW_TOKENS;
  const maxContextWindowTokens = Math.max(
    contextWindowTokens,
    positiveInteger(entry?.max_context_window) ?? contextWindowTokens,
  );
  const effectiveContextWindowPercent =
    positivePercentage(entry?.effective_context_window_percent) ??
    CODEX_OAUTH_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT;
  const effectiveContextWindowTokens = Math.floor(
    (contextWindowTokens * effectiveContextWindowPercent) / 100,
  );
  const maxEffectiveContextWindowTokens = Math.floor(
    (maxContextWindowTokens * effectiveContextWindowPercent) / 100,
  );
  return {
    contextWindowTokens,
    maxContextWindowTokens,
    effectiveContextWindowTokens,
    maxEffectiveContextWindowTokens,
    effectiveContextWindowPercent,
  };
}

export function normalizeCodexOAuthContextWindowTokens(
  model: string | undefined,
  requestedTokens: number | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (!isCodexOAuthModel(model)) return requestedTokens;
  const metadata = readCodexOAuthContextWindow(model, environment);
  if (!metadata) return requestedTokens;
  if (requestedTokens === undefined || !Number.isSafeInteger(requestedTokens) || requestedTokens <= 0) {
    return metadata.contextWindowTokens;
  }
  return Math.min(requestedTokens, metadata.maxContextWindowTokens);
}

/** Caps a user-visible/agent effective budget, rather than Codex's raw config value. */
export function normalizeCodexOAuthEffectiveContextWindowTokens(
  model: string | undefined,
  requestedTokens: number | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (!isCodexOAuthModel(model)) return requestedTokens;
  const metadata = readCodexOAuthContextWindow(model, environment);
  if (!metadata) return requestedTokens;
  if (requestedTokens === undefined || !Number.isSafeInteger(requestedTokens) || requestedTokens <= 0) {
    return metadata.effectiveContextWindowTokens;
  }
  return Math.min(requestedTokens, metadata.maxEffectiveContextWindowTokens);
}
