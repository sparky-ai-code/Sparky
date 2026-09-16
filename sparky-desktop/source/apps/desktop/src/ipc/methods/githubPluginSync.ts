// @effect-diagnostics globalDate:off globalFetch:off globalTimers:off - Electron main-process bridge keeps GitHub credentials out of the renderer.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { readGitHubPluginCredentialSnapshot } from "./githubPluginCredentials.ts";

const DEFAULT_PLUGIN_WORKER_URL = "https://auth.sparky.llc";
const AUTH_WAIT_TIMEOUT_MS = 5 * 60_000;
const AUTH_POLL_INTERVAL_MS = 750;

const SyncGitHubPluginInputSchema = Schema.Struct({
  sessionToken: Schema.String,
});

const SyncGitHubPluginResultSchema = Schema.Struct({
  connected: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});

function pluginWorkerBaseUrl(): string {
  const configured =
    process.env.SPARKY_PLUGIN_WORKER_URL?.trim() ||
    process.env.SPARKY_GITHUB_AUTH_BROKER_URL?.trim() ||
    DEFAULT_PLUGIN_WORKER_URL;
  try {
    const url = new URL(configured);
    const loopback =
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
    if (url.protocol !== "https:" && !loopback) return DEFAULT_PLUGIN_WORKER_URL;
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return DEFAULT_PLUGIN_WORKER_URL;
  }
}

async function waitForGitHubOAuthCredentials() {
  const deadline = Date.now() + AUTH_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const credentials = await readGitHubPluginCredentialSnapshot();
    if (credentials) return credentials;
    await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_INTERVAL_MS));
  }
  return null;
}

async function syncGitHubPluginConnection(input: {
  readonly sessionToken: string;
}): Promise<typeof SyncGitHubPluginResultSchema.Type> {
  const sessionToken = input.sessionToken.trim();
  if (sessionToken.length < 20 || /\s/u.test(sessionToken)) {
    return { connected: false, error: "The plugin session is invalid or expired." };
  }

  const credentials = await waitForGitHubOAuthCredentials();
  if (!credentials) {
    return {
      connected: false,
      error: "GitHub authorization did not complete. Finish the browser sign-in and try again.",
    };
  }

  try {
    const response = await fetch(`${pluginWorkerBaseUrl()}/v1/plugins/github/import`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
        "User-Agent": "Sparky-Desktop",
      },
      body: JSON.stringify({
        access_token: credentials.accessToken,
        token_type: credentials.tokenType,
        refresh_token: credentials.refreshToken,
        expires_at: credentials.expiresAt,
        refresh_token_expires_at: credentials.refreshTokenExpiresAt,
      }),
    });
    const value = (await response.json().catch(() => ({}))) as {
      readonly connected?: unknown;
      readonly error?: unknown;
    };
    if (!response.ok || value.connected !== true) {
      return {
        connected: false,
        error:
          typeof value.error === "string"
            ? value.error
            : `GitHub plugin sync returned HTTP ${response.status}.`,
      };
    }
    return { connected: true, error: null };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "GitHub plugin sync failed.",
    };
  }
}

export const syncGitHubPluginConnectionMethod = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GITHUB_PLUGIN_SYNC_CHANNEL,
  payload: SyncGitHubPluginInputSchema,
  result: SyncGitHubPluginResultSchema,
  handler: (input) => Effect.tryPromise(() => syncGitHubPluginConnection(input)),
});

export { pluginWorkerBaseUrl };
