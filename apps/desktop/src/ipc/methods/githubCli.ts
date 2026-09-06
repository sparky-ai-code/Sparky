import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - Electron main-process integration uses Node and browser-compatible APIs at this boundary.
import { execFile as execFileCallback } from "node:child_process";
import * as Fs from "node:fs/promises";
import { createServer } from "node:http";
import * as Path from "node:path";
import { promisify } from "node:util";

import { app, safeStorage, shell } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { GITHUB_OAUTH_SCOPE, githubUserRepositoriesPath } from "./githubOAuth.ts";
import { isDefinitiveGitHubAuthFailure } from "./githubResilience.ts";

const execFile = promisify(execFileCallback);

declare const __SPARKY_GITHUB_CLIENT_ID__: string;
declare const __SPARKY_GITHUB_AUTH_BROKER_URL__: string;

const GitHubCliAuthStatusSchema = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);

const GitHubCliStatusSchema = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  auth: GitHubCliAuthStatusSchema,
  account: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
});

const PullRequestScopeSchema = Schema.Literals(["all", "reviewing", "authored"]);

const GitHubRepositorySchema = Schema.Struct({
  nameWithOwner: Schema.String,
  url: Schema.String,
  isPrivate: Schema.NullOr(Schema.Boolean),
  isLocal: Schema.Boolean,
  updatedAt: Schema.NullOr(Schema.String),
});

const GitHubPullRequestSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  updatedAt: Schema.String,
  createdAt: Schema.String,
  authorLogin: Schema.NullOr(Schema.String),
  reviewDecision: Schema.NullOr(Schema.String),
  mergeable: Schema.NullOr(Schema.String),
  mergeStateStatus: Schema.NullOr(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  changedFiles: Schema.Number,
  body: Schema.NullOr(Schema.String),
  commentsCount: Schema.Number,
  reviewsCount: Schema.Number,
  checksCount: Schema.Number,
  failedChecksCount: Schema.Number,
  reviewers: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String),
});

const GitHubRepositoryListResultSchema = Schema.Struct({
  repositories: Schema.Array(GitHubRepositorySchema),
  error: Schema.NullOr(Schema.String),
});

const GitHubPullRequestListResultSchema = Schema.Struct({
  repository: Schema.String,
  pullRequests: Schema.Array(GitHubPullRequestSchema),
  error: Schema.NullOr(Schema.String),
});

const GitHubPullRequestDetailResultSchema = Schema.Struct({
  pullRequest: Schema.NullOr(GitHubPullRequestSchema),
  error: Schema.NullOr(Schema.String),
});

const ListRepositoriesInputSchema = Schema.Struct({ cwds: Schema.Array(Schema.String) });
const ListPullRequestsInputSchema = Schema.Struct({ repository: Schema.String, scope: PullRequestScopeSchema });
const GetPullRequestInputSchema = Schema.Struct({ repository: Schema.String, number: Schema.Number });

type GitHubCliStatus = typeof GitHubCliStatusSchema.Type;
type PullRequestScope = typeof PullRequestScopeSchema.Type;
type GitHubRepository = typeof GitHubRepositorySchema.Type;
type GitHubPullRequest = typeof GitHubPullRequestSchema.Type;
type GitHubRepositoryListResult = typeof GitHubRepositoryListResultSchema.Type;
type GitHubPullRequestListResult = typeof GitHubPullRequestListResultSchema.Type;
type GitHubPullRequestDetailResult = typeof GitHubPullRequestDetailResultSchema.Type;
type JsonRecord = Record<string, unknown>;

type GitHubCredentials = {
  version: 1;
  accessToken: string;
  tokenType: string;
  expiresAt: number | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
};

type BrokerTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number | null;
  refresh_token: string | null;
  refresh_token_expires_in: number | null;
};

class GitHubBrokerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GitHubBrokerError";
  }
}

class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GitHubApiError";
  }
}

const GITHUB_API = "https://api.github.com";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const CREDENTIALS_FILE = "github-auth-credentials.bin";
const LEGACY_TOKEN_FILE = "github-oauth-token.bin";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
const OAUTH_CALLBACK_PATH = "/github/oauth/callback";
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;

// Vite normally replaces these compile-time constants. Keep the runtime guard
// because a packaging tool that skips that replacement must leave GitHub auth
// unavailable, not crash Electron's main process during startup.
const builtClientId =
  typeof __SPARKY_GITHUB_CLIENT_ID__ === "string" ? __SPARKY_GITHUB_CLIENT_ID__.trim() : "";
const builtAuthBrokerUrl =
  typeof __SPARKY_GITHUB_AUTH_BROKER_URL__ === "string"
    ? __SPARKY_GITHUB_AUTH_BROKER_URL__.trim()
    : "";

const CLIENT_ID =
  process.env.SPARKY_GITHUB_CLIENT_ID?.trim() ||
  process.env.SPARKY_GITHUB_OAUTH_CLIENT_ID?.trim() ||
  builtClientId;
const AUTH_BROKER_URL = process.env.SPARKY_GITHUB_AUTH_BROKER_URL?.trim() || builtAuthBrokerUrl;

let credentialsCache: GitHubCredentials | null | undefined;
let authPromise: Promise<void> | null = null;
let authDetail: string | null = null;

function credentialsPath(): string {
  return Path.join(app.getPath("userData"), CREDENTIALS_FILE);
}

function legacyTokenPath(): string {
  return Path.join(app.getPath("userData"), LEGACY_TOKEN_FILE);
}

function securePersistenceAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== "linux") return true;
  try {
    return safeStorage.getSelectedStorageBackend() !== "basic_text";
  } catch {
    return false;
  }
}

function validCredentials(value: unknown): GitHubCredentials | null {
  if (!value || typeof value !== "object") return null;
  const record = value as JsonRecord;
  if (record.version !== 1 || typeof record.accessToken !== "string" || record.accessToken.length < 20) {
    return null;
  }
  return {
    version: 1,
    accessToken: record.accessToken,
    tokenType: typeof record.tokenType === "string" ? record.tokenType : "bearer",
    expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : null,
    refreshToken: typeof record.refreshToken === "string" ? record.refreshToken : null,
    refreshTokenExpiresAt:
      typeof record.refreshTokenExpiresAt === "number" ? record.refreshTokenExpiresAt : null,
  };
}

async function removeLegacyCredentialFile(): Promise<void> {
  await Fs.rm(legacyTokenPath(), { force: true }).catch(() => undefined);
}

async function loadCredentials(): Promise<GitHubCredentials | null> {
  if (credentialsCache !== undefined) return credentialsCache;
  await removeLegacyCredentialFile();
  if (!securePersistenceAvailable()) {
    credentialsCache = null;
    return null;
  }
  try {
    const encrypted = await Fs.readFile(credentialsPath());
    const decoded = safeStorage.decryptString(encrypted);
    credentialsCache = validCredentials(JSON.parse(decoded));
    if (!credentialsCache) await Fs.rm(credentialsPath(), { force: true }).catch(() => undefined);
  } catch {
    credentialsCache = null;
    await Fs.rm(credentialsPath(), { force: true }).catch(() => undefined);
  }
  return credentialsCache;
}

async function saveCredentials(credentials: GitHubCredentials): Promise<void> {
  credentialsCache = credentials;
  if (!securePersistenceAvailable()) {
    await Fs.rm(credentialsPath(), { force: true }).catch(() => undefined);
    return;
  }
  await Fs.mkdir(Path.dirname(credentialsPath()), { recursive: true });
  const encrypted = safeStorage.encryptString(JSON.stringify(credentials));
  await Fs.writeFile(credentialsPath(), encrypted, { mode: 0o600 });
}

async function clearCredentials(): Promise<void> {
  credentialsCache = null;
  await Promise.all([
    Fs.rm(credentialsPath(), { force: true }).catch(() => undefined),
    Fs.rm(legacyTokenPath(), { force: true }).catch(() => undefined),
  ]);
}

function configuredBrokerUrl(): string | null {
  if (!AUTH_BROKER_URL) return null;
  try {
    const url = new URL(AUTH_BROKER_URL);
    const loopbackDev = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "::1");
    if (url.protocol !== "https:" && !loopbackDev) return null;
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function authConfigurationError(): string | null {
  if (!CLIENT_ID) return "GitHub authentication is not configured: missing SPARKY_GITHUB_CLIENT_ID.";
  if (!configuredBrokerUrl()) {
    return "GitHub authentication is not configured: SPARKY_GITHUB_AUTH_BROKER_URL must be HTTPS (or loopback HTTP for development).";
  }
  return null;
}

async function brokerJson(path: string, body: JsonRecord): Promise<JsonRecord> {
  const base = configuredBrokerUrl();
  if (!base) throw new Error("GitHub authentication broker is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Sparky-Desktop",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let value: JsonRecord = {};
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as JsonRecord;
    } catch {
      // Preserve the HTTP error below without exposing response internals.
    }
  }
  if (!response.ok) {
    throw new GitHubBrokerError(
      response.status,
      typeof value.error === "string" ? value.error : `GitHub authentication broker returned HTTP ${response.status}.`,
    );
  }
  return value;
}

function credentialsFromBroker(value: JsonRecord): GitHubCredentials {
  if (typeof value.access_token !== "string" || value.access_token.length < 20) {
    throw new Error("GitHub authentication broker returned an invalid access token response.");
  }
  const now = Date.now();
  const expiresIn = typeof value.expires_in === "number" && value.expires_in > 0 ? value.expires_in : null;
  const refreshExpiresIn =
    typeof value.refresh_token_expires_in === "number" && value.refresh_token_expires_in > 0
      ? value.refresh_token_expires_in
      : null;
  return {
    version: 1,
    accessToken: value.access_token,
    tokenType: typeof value.token_type === "string" ? value.token_type : "bearer",
    expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
    refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : null,
    refreshTokenExpiresAt: refreshExpiresIn === null ? null : now + refreshExpiresIn * 1000,
  };
}

async function refreshCredentials(force = false): Promise<GitHubCredentials | null> {
  const current = await loadCredentials();
  if (!current) return null;
  if (!force && (current.expiresAt === null || current.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now())) {
    return current;
  }
  if (!current.refreshToken) {
    // A stale token is not proof that the encrypted credential should be
    // deleted. Let GitHub decide whether it is still usable.
    return current;
  }
  if (current.refreshTokenExpiresAt !== null && current.refreshTokenExpiresAt <= Date.now()) {
    return current;
  }
  try {
    const value = await brokerJson("/v1/github/refresh", { refresh_token: current.refreshToken });
    const refreshed = credentialsFromBroker(value);
    await saveCredentials(refreshed);
    return refreshed;
  } catch (error) {
    if (
      isDefinitiveGitHubAuthFailure(
        error instanceof GitHubBrokerError ? error.status : null,
        error instanceof Error ? error.message : String(error),
      )
    ) {
      await clearCredentials();
      return null;
    }
    return current;
  }
}

async function getAccessToken(): Promise<string | null> {
  try {
    return (await refreshCredentials(false))?.accessToken ?? null;
  } catch {
    return (await loadCredentials())?.accessToken ?? null;
  }
}

async function fetchGitHub(path: string, init: RequestInit, headers: Headers): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    return await fetch(`${GITHUB_API}${path}`, { ...init, headers, signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function githubFetch(path: string, init: RequestInit = {}, allowRefresh = true): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new Error("GitHub authentication is required.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", headers.get("Accept") ?? "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "Sparky-Desktop");
  const response = await fetchGitHub(path, init, headers);
  if (response.status !== 401 || !allowRefresh) return response;

  const refreshed = await refreshCredentials(true);
  if (!refreshed || refreshed.accessToken === token) {
    return response;
  }
  const retryHeaders = new Headers(init.headers);
  retryHeaders.set("Authorization", `Bearer ${refreshed.accessToken}`);
  retryHeaders.set("Accept", retryHeaders.get("Accept") ?? "application/vnd.github+json");
  retryHeaders.set("X-GitHub-Api-Version", "2022-11-28");
  retryHeaders.set("User-Agent", "Sparky-Desktop");
  return fetchGitHub(path, init, retryHeaders);
}

async function githubJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await githubFetch(path, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GitHubApiError(response.status, `GitHub API ${response.status}: ${detail || response.statusText}`);
  }
  return response.json() as Promise<unknown>;
}

async function currentUser(): Promise<string | null> {
  const value = await githubJson("/user");
  if (typeof value !== "object" || value === null) return null;
  const login = (value as JsonRecord).login;
  return typeof login === "string" ? login : null;
}

async function getGitHubCliStatus(): Promise<GitHubCliStatus> {
  const configurationError = authConfigurationError();
  if (configurationError) {
    return { installed: true, version: "GitHub OAuth App + PKCE", auth: "unknown", account: null, detail: configurationError };
  }
  const credentials = await loadCredentials();
  if (!credentials) {
    return {
      installed: true,
      version: "GitHub OAuth App + PKCE",
      auth: "unauthenticated",
      account: null,
      detail:
        authDetail ??
        (securePersistenceAvailable()
          ? null
          : "Secure OS credential storage is unavailable. GitHub login will work for this session only and will not be written to disk."),
    };
  }
  try {
    const account = await currentUser();
    if (!account) throw new Error("GitHub did not return an account.");
    return { installed: true, version: "GitHub OAuth App + PKCE", auth: "authenticated", account, detail: authDetail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const status =
      error instanceof GitHubBrokerError || error instanceof GitHubApiError ? error.status : null;
    if (isDefinitiveGitHubAuthFailure(status, detail)) {
      await clearCredentials();
      return {
        installed: true,
        version: "GitHub OAuth App + PKCE",
        auth: "unauthenticated",
        account: null,
        detail,
      };
    }
    return {
      installed: true,
      version: "GitHub OAuth App + PKCE",
      auth: "unknown",
      account: null,
      detail: "Could not reach GitHub. Your session was kept; try again later.",
    };
  }
}

async function installGitHubCli(): Promise<GitHubCliStatus> {
  return getGitHubCliStatus();
}

export function ensureGitHubCliInstalled(): Promise<GitHubCliStatus> {
  return getGitHubCliStatus();
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function statesEqual(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function callbackHtml(success: boolean): string {
  const title = success ? "GitHub connected" : "GitHub connection failed";
  const message = success
    ? "Authorization is complete. You can close this tab and return to Sparky."
    : "Authorization could not be completed. Return to Sparky and try again.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fff;color:#111}.card{max-width:520px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 10px}p{font-size:14px;line-height:1.5;color:#555}</style></head><body><main class="card"><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

async function runAuthorizationCodeFlow(): Promise<void> {
  const configurationError = authConfigurationError();
  if (configurationError) throw new Error(configurationError);

  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const challenge = pkceChallenge(verifier);

  let resolveCallback: ((value: string) => void) | undefined;
  let rejectCallback: ((error: Error) => void) | undefined;
  const callbackPromise = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== OAUTH_CALLBACK_PATH) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end("Not found");
        return;
      }
      const returnedState = url.searchParams.get("state") ?? "";
      if (!statesEqual(returnedState, state)) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(callbackHtml(false));
        rejectCallback?.(new Error("GitHub authorization state validation failed."));
        return;
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(callbackHtml(false));
        rejectCallback?.(new Error(url.searchParams.get("error_description") || oauthError));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(callbackHtml(false));
        rejectCallback?.(new Error("GitHub did not return an authorization code."));
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end(callbackHtml(true));
      resolveCallback?.(code);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Bad request");
      rejectCallback?.(new Error("Could not process GitHub authorization callback."));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a local OAuth callback port.");
  }
  const redirectUri = `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`;
  const authorize = new URL(GITHUB_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("scope", GITHUB_OAUTH_SCOPE);
  authorize.searchParams.set("prompt", "select_account");

  authDetail = "Complete the GitHub authorization in your browser.";
  await shell.openExternal(authorize.toString());

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("GitHub authorization timed out. Please try again.")), OAUTH_CALLBACK_TIMEOUT_MS);
  });

  try {
    const code = await Promise.race([callbackPromise, timeout]);
    const tokenValue = await brokerJson("/v1/github/exchange", {
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    const credentials = credentialsFromBroker(tokenValue);
    await saveCredentials(credentials);
    authDetail = securePersistenceAvailable()
      ? null
      : "Connected for this session. Secure OS credential storage is unavailable, so credentials were not persisted.";

  } finally {
    server.close();
  }
}

async function startGitHubCliAuth(): Promise<GitHubCliStatus> {
  if (authConfigurationError()) return getGitHubCliStatus();
  if (!authPromise) {
    authPromise = runAuthorizationCodeFlow()
      .catch((error) => {
        authDetail = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        authPromise = null;
      });
  }
  return getGitHubCliStatus();
}

async function disconnectGitHub(): Promise<GitHubCliStatus> {
  const current = await loadCredentials();
  if (current && configuredBrokerUrl()) {
    await brokerJson("/v1/github/revoke", { access_token: current.accessToken }).catch(() => undefined);
  }
  await clearCredentials();
  authDetail = null;
  return getGitHubCliStatus();
}

function parseRemoteRepository(remote: string): string | null {
  const text = remote.trim().replace(/\.git$/u, "");
  const ssh = text.match(/^git@github\.com:([^/]+\/[^/]+)$/iu);
  if (ssh) return ssh[1] ?? null;
  try {
    const url = new URL(text);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const name = url.pathname.replace(/^\//u, "");
    return /^[^/]+\/[^/]+$/u.test(name) ? name : null;
  } catch {
    return null;
  }
}

async function resolveRepositoryName(cwd: string): Promise<string | null> {
  try {
    const result = await execFile("git", ["remote", "get-url", "origin"], {
      cwd,
      windowsHide: true,
      timeout: 5000,
    });
    return parseRemoteRepository(result.stdout);
  } catch {
    return null;
  }
}

async function listUserRepositories(): Promise<GitHubRepository[]> {
  const repositories = new Map<string, GitHubRepository>();
  for (let page = 1; page <= 10; page += 1) {
    const value = await githubJson(githubUserRepositoriesPath(page));
    if (!Array.isArray(value)) throw new Error("GitHub returned an invalid repository list.");
    for (const repoValue of value) {
      if (!repoValue || typeof repoValue !== "object") continue;
      const repo = repoValue as JsonRecord;
      if (typeof repo.full_name !== "string" || typeof repo.html_url !== "string") continue;
      repositories.set(repo.full_name, {
        nameWithOwner: repo.full_name,
        url: repo.html_url,
        isPrivate: typeof repo.private === "boolean" ? repo.private : null,
        isLocal: false,
        updatedAt: typeof repo.updated_at === "string" ? repo.updated_at : null,
      });
    }
    if (value.length < 100) break;
  }
  return [...repositories.values()].sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
}

async function listRepositories(input: { cwds: readonly string[] }): Promise<GitHubRepositoryListResult> {
  const status = await getGitHubCliStatus();
  if (status.auth !== "authenticated") {
    return { repositories: [], error: status.detail ?? "GitHub is not authenticated." };
  }

  const localNames = new Set<string>();
  for (const cwd of [...new Set(input.cwds)]) {
    const name = await resolveRepositoryName(cwd);
    if (name) localNames.add(name);
  }

  try {
    const repositories = (await listUserRepositories()).map((repository) => ({
      ...repository,
      isLocal: localNames.has(repository.nameWithOwner),
    }));
    repositories.sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    if (repositories.length === 0) {
      return { repositories: [], error: "No repositories are available to this GitHub OAuth authorization." };
    }
    return { repositories, error: null };
  } catch (error) {
    return { repositories: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function prFromRest(value: unknown): GitHubPullRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as JsonRecord;
  const head = item.head as JsonRecord | undefined;
  const base = item.base as JsonRecord | undefined;
  const user = item.user as JsonRecord | undefined;
  if (
    typeof item.number !== "number" ||
    typeof item.title !== "string" ||
    typeof item.html_url !== "string" ||
    typeof item.updated_at !== "string"
  ) {
    return null;
  }
  return {
    number: item.number,
    title: item.title,
    url: item.html_url,
    state: typeof item.merged_at === "string" ? "MERGED" : String(item.state ?? "OPEN").toUpperCase(),
    isDraft: item.draft === true,
    headRefName: typeof head?.ref === "string" ? head.ref : "",
    baseRefName: typeof base?.ref === "string" ? base.ref : "",
    updatedAt: item.updated_at,
    createdAt: typeof item.created_at === "string" ? item.created_at : item.updated_at,
    authorLogin: typeof user?.login === "string" ? user.login : null,
    reviewDecision: null,
    mergeable: typeof item.mergeable === "boolean" ? (item.mergeable ? "MERGEABLE" : "CONFLICTING") : null,
    mergeStateStatus: typeof item.mergeable_state === "string" ? item.mergeable_state.toUpperCase() : null,
    additions: typeof item.additions === "number" ? item.additions : 0,
    deletions: typeof item.deletions === "number" ? item.deletions : 0,
    changedFiles: typeof item.changed_files === "number" ? item.changed_files : 0,
    body: typeof item.body === "string" ? item.body : null,
    commentsCount: typeof item.comments === "number" ? item.comments : 0,
    reviewsCount: typeof item.review_comments === "number" ? item.review_comments : 0,
    checksCount: 0,
    failedChecksCount: 0,
    reviewers: Array.isArray(item.requested_reviewers)
      ? item.requested_reviewers.flatMap((reviewer) =>
          typeof reviewer === "object" && reviewer !== null && typeof (reviewer as JsonRecord).login === "string"
            ? [(reviewer as JsonRecord).login as string]
            : [],
        )
      : [],
    labels: Array.isArray(item.labels)
      ? item.labels.flatMap((label) =>
          typeof label === "object" && label !== null && typeof (label as JsonRecord).name === "string"
            ? [(label as JsonRecord).name as string]
            : [],
        )
      : [],
  };
}

async function listPullRequests(input: {
  repository: string;
  scope: PullRequestScope;
}): Promise<GitHubPullRequestListResult> {
  const status = await getGitHubCliStatus();
  if (status.auth !== "authenticated") {
    return { repository: input.repository, pullRequests: [], error: status.detail ?? "GitHub is not authenticated." };
  }
  try {
    const [owner, repo] = input.repository.split("/", 2);
    if (!owner || !repo) throw new Error("Invalid GitHub repository name.");
    const value = await githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&per_page=100&sort=updated&direction=desc`,
    );
    if (!Array.isArray(value)) throw new Error("GitHub returned an invalid pull request list.");
    let pullRequests = value.flatMap((item) => {
      const pr = prFromRest(item);
      return pr ? [pr] : [];
    });
    if (input.scope === "authored" && status.account) {
      pullRequests = pullRequests.filter((pr) => pr.authorLogin === status.account);
    } else if (input.scope === "reviewing" && status.account) {
      const reviewer = status.account.toLowerCase();
      pullRequests = pullRequests.filter((pr) => pr.reviewers.some((name) => name.toLowerCase() === reviewer));
    }
    return { repository: input.repository, pullRequests, error: null };
  } catch (error) {
    return { repository: input.repository, pullRequests: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function getPullRequest(input: {
  repository: string;
  number: number;
}): Promise<GitHubPullRequestDetailResult> {
  const status = await getGitHubCliStatus();
  if (status.auth !== "authenticated") {
    return { pullRequest: null, error: status.detail ?? "GitHub is not authenticated." };
  }
  try {
    const [owner, repo] = input.repository.split("/", 2);
    if (!owner || !repo) throw new Error("Invalid GitHub repository name.");
    const value = await githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.number}`,
    );
    const pullRequest = prFromRest(value);
    return pullRequest
      ? { pullRequest, error: null }
      : { pullRequest: null, error: "GitHub returned an invalid pull request response." };
  } catch (error) {
    return { pullRequest: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getGitHubOAuthToken(): Promise<string | null> {
  return getAccessToken();
}

export const getStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GITHUB_CLI_STATUS_CHANNEL,
  payload: Schema.Void,
  result: GitHubCliStatusSchema,
  handler: () => Effect.tryPromise(() => getGitHubCliStatus()),
});

export const install = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GITHUB_CLI_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: GitHubCliStatusSchema,
  handler: () => Effect.tryPromise(() => installGitHubCli()),
});

export const startAuth = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GITHUB_CLI_AUTH_CHANNEL,
  payload: Schema.Void,
  result: GitHubCliStatusSchema,
  handler: () => Effect.tryPromise(() => startGitHubCliAuth()),
});

export const disconnect = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GITHUB_AUTH_DISCONNECT_CHANNEL,
  payload: Schema.Void,
  result: GitHubCliStatusSchema,
  handler: () => Effect.tryPromise(() => disconnectGitHub()),
});

export const listRepositoriesMethod = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GITHUB_CLI_LIST_REPOSITORIES_CHANNEL,
  payload: ListRepositoriesInputSchema,
  result: GitHubRepositoryListResultSchema,
  handler: (input) => Effect.tryPromise(() => listRepositories(input)),
});

export const list = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GITHUB_CLI_LIST_PULL_REQUESTS_CHANNEL,
  payload: ListPullRequestsInputSchema,
  result: GitHubPullRequestListResultSchema,
  handler: (input) => Effect.tryPromise(() => listPullRequests(input)),
});

export const getPullRequestMethod = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GITHUB_CLI_GET_PULL_REQUEST_CHANNEL,
  payload: GetPullRequestInputSchema,
  result: GitHubPullRequestDetailResultSchema,
  handler: (input) => Effect.tryPromise(() => getPullRequest(input)),
});
