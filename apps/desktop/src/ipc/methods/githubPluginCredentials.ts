// @effect-diagnostics nodeBuiltinImport:off - Electron main-process credential bridge never exposes provider tokens to the renderer.
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { app, safeStorage } from "electron";

import { getGitHubOAuthToken } from "./githubCli.ts";

const CREDENTIALS_FILE = "github-auth-credentials.bin";

type PersistedGitHubCredentials = {
  readonly version: 1;
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresAt: number | null;
  readonly refreshToken: string | null;
  readonly refreshTokenExpiresAt: number | null;
};

export type GitHubPluginCredentialSnapshot = {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresAt: number | null;
  readonly refreshToken: string | null;
  readonly refreshTokenExpiresAt: number | null;
};

function credentialsPath(): string {
  return Path.join(app.getPath("userData"), CREDENTIALS_FILE);
}

function persistedCredentials(value: unknown): PersistedGitHubCredentials | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.accessToken !== "string" ||
    record.accessToken.length < 20
  ) {
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

async function readPersistedCredentials(): Promise<PersistedGitHubCredentials | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  if (process.platform === "linux") {
    try {
      if (safeStorage.getSelectedStorageBackend() === "basic_text") return null;
    } catch {
      return null;
    }
  }
  try {
    const encrypted = await Fs.readFile(credentialsPath());
    return persistedCredentials(JSON.parse(safeStorage.decryptString(encrypted)));
  } catch {
    return null;
  }
}

/**
 * Reads the already-authorized GitHub credential entirely in Electron main.
 * Calling getGitHubOAuthToken first lets the existing integration refresh the
 * credential before we snapshot its expiry/refresh metadata for the Worker.
 */
export async function readGitHubPluginCredentialSnapshot(): Promise<GitHubPluginCredentialSnapshot | null> {
  const accessToken = await getGitHubOAuthToken();
  if (!accessToken) return null;

  const persisted = await readPersistedCredentials();
  if (!persisted || persisted.accessToken !== accessToken) {
    // Secure persistence can be unavailable on some systems. The connection can
    // still be imported for the current token lifetime; the desktop integration
    // remains the source of truth and can re-sync later.
    return {
      accessToken,
      tokenType: "bearer",
      expiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    };
  }

  return {
    accessToken: persisted.accessToken,
    tokenType: persisted.tokenType,
    expiresAt: persisted.expiresAt,
    refreshToken: persisted.refreshToken,
    refreshTokenExpiresAt: persisted.refreshTokenExpiresAt,
  };
}
