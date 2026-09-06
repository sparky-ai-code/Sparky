import * as Effect from "effect/Effect";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import type { PluginId } from "./pluginCatalog";

const DEFAULT_WORKER_URL = "https://auth.sparky.llc";
const SESSION_STORAGE_KEY = "sparky.plugin-session.v1";
const PLUGIN_STATUS_CACHE_TTL_MS = 5 * 60_000;

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
      typeof value.error === "string" ? value.error : `Request failed with HTTP ${response.status}.`,
    );
  }
  return value;
}

export function loadPluginSessionToken(): string | null {
  try {
    const value = window.localStorage.getItem(SESSION_STORAGE_KEY)?.trim() ?? "";
    return value.length >= 20 ? value : null;
  } catch {
    return null;
  }
}

export function persistPluginSessionToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(SESSION_STORAGE_KEY, token);
    else window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Local storage can be unavailable in hardened browser contexts. The live
    // session still works; the next launch will simply mint a new broker token.
  }
}

export async function syncPluginSessionToServer(token: string | null): Promise<void> {
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
}

export async function createPluginSession(clerkJwt: string): Promise<PluginSession> {
  const response = await fetch(`${workerBaseUrl()}/v1/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${clerkJwt}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const session = await readJson<PluginSession>(response);
  invalidatePluginStatusCache();
  persistPluginSessionToken(session.sessionToken);
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

export async function clearPluginSession(): Promise<void> {
  invalidatePluginStatusCache();
  persistPluginSessionToken(null);
  await syncPluginSessionToServer(null).catch(() => undefined);
}
