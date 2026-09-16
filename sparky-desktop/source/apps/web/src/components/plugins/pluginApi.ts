import * as Effect from "effect/Effect";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import type { PluginId } from "./pluginCatalog";

const DEFAULT_WORKER_URL = "https://auth.sparky.llc";
const SESSION_STORAGE_KEY = "sparky.plugin-session.v1";
const PENDING_SESSION_REVOKE_STORAGE_KEY = "sparky.plugin-session-revoke.v1";
const PLUGIN_STATUS_CACHE_TTL_MS = 5 * 60_000;

let inMemorySessionToken: string | null | undefined;

export interface PluginStatus {
  readonly pluginId: PluginId;
  readonly connected: boolean;
  readonly metadata: Record<string, unknown> | null;
}

export interface PluginSession {
  readonly sessionToken: string;
  readonly user: { readonly id: string; readonly email: string | null };
}

export interface PendingPluginAuthorization {
  readonly pluginId: PluginId;
  readonly requestedAt: number | null;
}

export interface PluginAnalyticsEvent {
  readonly type:
    | "prompt"
    | "model_call"
    | "model_request"
    | "agent_call"
    | "plugin_authorization"
    | "plugin_use";
  readonly eventId?: string;
  readonly model?: string | null;
  readonly provider?: string | null;
  readonly pluginId?: PluginId | null;
  readonly action?: string | null;
}

type GitHubPluginBridge = {
  readonly getGitHubCliStatus?: () => Promise<{ readonly auth?: string }>;
  readonly startGitHubCliAuth?: () => Promise<unknown>;
  readonly syncGitHubPluginConnection?: (input: {
    readonly sessionToken: string;
  }) => Promise<{ readonly connected: boolean; readonly error: string | null }>;
};

type PluginStatusCacheEntry = {
  statuses: PluginStatus[];
  fetchedAt: number;
  inFlight: Promise<PluginStatus[]> | null;
};

const pluginStatusCache = new Map<string, PluginStatusCacheEntry>();

function githubPluginBridge(): GitHubPluginBridge | null {
  return (window.desktopBridge as unknown as GitHubPluginBridge | undefined) ?? null;
}

function workerBaseUrl(): string {
  const configured = import.meta.env.VITE_SPARKY_PLUGIN_WORKER_URL?.trim() || DEFAULT_WORKER_URL;
  return configured.replace(/\/$/u, "");
}

async function readJson<T>(response: Response): Promise<T> {
  const value = (await response.json().catch(() => ({}))) as T & {
    readonly error?: string;
  };
  if (!response.ok) {
    throw new Error(
      typeof value.error === "string"
        ? value.error
        : `Request failed with HTTP ${response.status}.`,
    );
  }
  return value;
}

export function loadPluginSessionToken(): string | null {
  if (inMemorySessionToken !== undefined) return inMemorySessionToken;
  try {
    const value = window.localStorage.getItem(SESSION_STORAGE_KEY)?.trim() ?? "";
    inMemorySessionToken = value.length >= 20 ? value : null;
    return inMemorySessionToken;
  } catch {
    return null;
  }
}

function writeLocalSessionToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(SESSION_STORAGE_KEY, token);
    else window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Local storage is only a web/fallback persistence mechanism.
  }
}

export function persistPluginSessionToken(token: string | null): void {
  inMemorySessionToken = token;
  writeLocalSessionToken(token);
}

export async function loadPersistedPluginSessionToken(): Promise<string | null> {
  const desktopBridge = window.desktopBridge;
  if (typeof desktopBridge?.getAccountSessionToken === "function") {
    const secureToken = await desktopBridge.getAccountSessionToken().catch(() => null);
    if (typeof secureToken === "string" && secureToken.length >= 20) {
      // Do not copy the encrypted-store value back into plaintext localStorage.
      inMemorySessionToken = secureToken;
      return secureToken;
    }
  }
  const localToken = loadPluginSessionToken();
  if (localToken && typeof desktopBridge?.setAccountSessionToken === "function") {
    await persistPluginSessionTokenDurably(localToken);
  }
  return localToken;
}

async function persistPluginSessionTokenDurably(token: string | null): Promise<void> {
  const desktopBridge = window.desktopBridge;
  if (typeof desktopBridge?.setAccountSessionToken === "function") {
    inMemorySessionToken = token;
    const persisted = await desktopBridge.setAccountSessionToken(token).catch(() => false);
    if (persisted) {
      writeLocalSessionToken(null);
    } else {
      writeLocalSessionToken(token);
    }
    return;
  }
  persistPluginSessionToken(token);
}

function loadPendingSessionRevocations(): string[] {
  try {
    const raw = window.localStorage.getItem(PENDING_SESSION_REVOKE_STORAGE_KEY)?.trim() ?? "";
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (value): value is string => typeof value === "string" && value.length >= 20,
        );
      }
    } catch {
      // Migrate the first version of this value, which stored one raw token.
    }
    return raw.length >= 20 ? [raw] : [];
  } catch {
    return [];
  }
}

function persistPendingSessionRevocations(tokens: readonly string[]): void {
  try {
    if (tokens.length > 0) {
      window.localStorage.setItem(
        PENDING_SESSION_REVOKE_STORAGE_KEY,
        JSON.stringify([...new Set(tokens)]),
      );
    } else {
      window.localStorage.removeItem(PENDING_SESSION_REVOKE_STORAGE_KEY);
    }
  } catch {
    // A failed local-storage write cannot prevent the local session from being
    // cleared. The worker-side session still has its normal revocation path.
  }
}

async function revokePluginSessionRemotely(sessionToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${workerBaseUrl()}/v1/session`, {
      method: "DELETE",
      headers: authenticatedHeaders(sessionToken),
    });
    // An already-invalid token is fully revoked from the client's perspective.
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

export async function retryPendingPluginSessionRevocation(): Promise<void> {
  const pendingTokens = loadPendingSessionRevocations();
  for (const pendingToken of pendingTokens) {
    if (await revokePluginSessionRemotely(pendingToken)) {
      persistPendingSessionRevocations(
        loadPendingSessionRevocations().filter((token) => token !== pendingToken),
      );
    }
  }
}

export async function syncPluginSessionToServer(token: string | null): Promise<void> {
  const retryDelaysMs = [0, 250, 750, 1_500] as const;
  let lastError: unknown;

  for (const [attempt, delayMs] of retryDelaysMs.entries()) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const result = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.plugins.syncSession({
              headers: {},
              payload: { sessionToken: token },
            }),
          ),
        ),
      );
      if (token && !result.ready) {
        throw new Error("The local Sparky server rejected the plugin session.");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt === retryDelaysMs.length - 1) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Plugin session sync failed.");
}

export async function createPluginSession(clerkJwt: string): Promise<PluginSession> {
  await retryPendingPluginSessionRevocation();
  const response = await fetch(`${workerBaseUrl()}/v1/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${clerkJwt}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const session = await readJson<PluginSession>(response);
  invalidatePluginStatusCache();
  await persistPluginSessionTokenDurably(session.sessionToken);
  await syncPluginSessionToServer(session.sessionToken);
  return session;
}

function authenticatedHeaders(sessionToken: string): HeadersInit {
  return { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" };
}

export function invalidatePluginStatusCache(sessionToken?: string): void {
  if (sessionToken) {
    pluginStatusCache.delete(sessionToken);
    return;
  }
  pluginStatusCache.clear();
}

export async function listPluginStatus(
  sessionToken: string,
  options: { readonly forceRefresh?: boolean } = {},
): Promise<PluginStatus[]> {
  const cached = pluginStatusCache.get(sessionToken);
  const forceRefresh = options.forceRefresh === true;
  if (cached?.inFlight) return cached.inFlight;
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < PLUGIN_STATUS_CACHE_TTL_MS) {
    return cached.statuses;
  }

  const entry: PluginStatusCacheEntry = cached ?? {
    statuses: [],
    fetchedAt: 0,
    inFlight: null,
  };
  const request = (async () => {
    const response = await fetch(`${workerBaseUrl()}/v1/plugins`, {
      headers: authenticatedHeaders(sessionToken),
    });
    return (await readJson<{ plugins: PluginStatus[] }>(response)).plugins;
  })();
  entry.inFlight = request;
  pluginStatusCache.set(sessionToken, entry);

  try {
    const statuses = await request;
    entry.statuses = statuses;
    entry.fetchedAt = Date.now();
    return statuses;
  } finally {
    if (entry.inFlight === request) entry.inFlight = null;
  }
}

export async function listPendingPluginAuthorizations(
  sessionToken: string,
): Promise<PendingPluginAuthorization[]> {
  const response = await fetch(`${workerBaseUrl()}/v1/plugins/pending`, {
    headers: authenticatedHeaders(sessionToken),
  });
  return (await readJson<{ pending: PendingPluginAuthorization[] }>(response)).pending;
}

export async function startPluginAuthorization(
  sessionToken: string,
  pluginId: PluginId,
): Promise<{
  readonly status: string;
  readonly authorizationUrl: string | null;
  readonly managedBy?: string;
}> {
  const response = await fetch(`${workerBaseUrl()}/v1/plugins/${pluginId}/authorize`, {
    method: "POST",
    headers: authenticatedHeaders(sessionToken),
    body: "{}",
  });
  return readJson(response);
}

export async function cancelPluginAuthorization(
  sessionToken: string,
  pluginId: PluginId,
): Promise<void> {
  const response = await fetch(`${workerBaseUrl()}/v1/plugins/${pluginId}/cancel`, {
    method: "POST",
    headers: authenticatedHeaders(sessionToken),
    body: "{}",
  });
  await readJson(response);
}

export async function disconnectPlugin(sessionToken: string, pluginId: PluginId): Promise<void> {
  const response = await fetch(`${workerBaseUrl()}/v1/plugins/${pluginId}`, {
    method: "DELETE",
    headers: authenticatedHeaders(sessionToken),
  });
  await readJson(response);
  invalidatePluginStatusCache(sessionToken);
}

export async function waitForPluginConnection(
  sessionToken: string,
  pluginId: PluginId,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  const intervalMs = options.intervalMs ?? 800;
  while (Date.now() < deadline) {
    const statuses = await listPluginStatus(sessionToken, { forceRefresh: true });
    if (statuses.some((entry) => entry.pluginId === pluginId && entry.connected)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
  }
  return false;
}

export function openPluginAuthorizationUrl(url: string): void {
  const openExternal = window.desktopBridge?.openExternal;
  if (typeof openExternal === "function") {
    void openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function connectPlugin(sessionToken: string, pluginId: PluginId): Promise<void> {
  if (pluginId === "github") {
    const bridge = githubPluginBridge();
    if (!bridge?.startGitHubCliAuth || !bridge.syncGitHubPluginConnection) {
      throw new Error("GitHub authorization is only available in the desktop app.");
    }
    const status = await bridge.getGitHubCliStatus?.().catch(() => null);
    if (status?.auth !== "authenticated") {
      await bridge.startGitHubCliAuth();
    }
    const result = await bridge.syncGitHubPluginConnection({ sessionToken });
    if (!result.connected) {
      throw new Error(result.error || "GitHub could not be connected to Sparky plugins.");
    }
    return;
  }

  const result = await startPluginAuthorization(sessionToken, pluginId);
  if (result.status === "connected") return;
  if (!result.authorizationUrl) {
    throw new Error("This plugin did not return an authorization URL.");
  }
  openPluginAuthorizationUrl(result.authorizationUrl);
  const connected = await waitForPluginConnection(sessionToken, pluginId);
  if (!connected) throw new Error(`${pluginId} authorization timed out.`);
}

export async function recordPluginAnalyticsEvent(input: PluginAnalyticsEvent): Promise<void> {
  const sessionToken = loadPluginSessionToken();
  if (!sessionToken) return;
  const response = await fetch(`${workerBaseUrl()}/v1/analytics/events`, {
    method: "POST",
    headers: authenticatedHeaders(sessionToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Analytics endpoint returned HTTP ${response.status}.`);
  }
}

export async function clearPluginSession(expectedSessionToken?: string): Promise<void> {
  const sessionToken = loadPluginSessionToken();
  // A restore request can finish after a newer sign-in has already persisted a
  // replacement token. Never revoke or clear that newer session while cleaning
  // up the token that failed to restore.
  if (expectedSessionToken !== undefined && sessionToken !== expectedSessionToken) return;
  invalidatePluginStatusCache();
  if (sessionToken) {
    persistPendingSessionRevocations([...loadPendingSessionRevocations(), sessionToken]);
  }
  await persistPluginSessionTokenDurably(null);
  if (sessionToken && (await revokePluginSessionRemotely(sessionToken))) {
    persistPendingSessionRevocations(
      loadPendingSessionRevocations().filter((token) => token !== sessionToken),
    );
  }
  await syncPluginSessionToServer(null).catch(() => undefined);
}
