// @effect-diagnostics nodeBuiltinImport:off - Atomic local file permissions require Node FS primitives.
// @effect-diagnostics globalDate:off - Vault timestamps use the system wall-clock ISO representation.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app, safeStorage } from "electron";
import type { SecretVaultEntry, SecretVaultWriteInput } from "@sparky/contracts";

interface StoredEntry {
  readonly metadata: SecretVaultEntry;
  readonly cipherText: string | null;
}
type VaultFile = { readonly version: 1; readonly entries: readonly StoredEntry[] };

const vaultPath = () => path.join(app.getPath("userData"), "sparky-secret-vault-v1.json");
let pending: Promise<unknown> = Promise.resolve();

function serialized<T>(callback: () => Promise<T>): Promise<T> {
  const result = pending.then(callback, callback);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

function requireSystemEncryption(): void {
  // Electron's Linux "basic_text" fallback is NOT encryption. Fail closed there.
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend() === "basic_text") {
    throw new Error("Secure credential storage is unavailable. Unlock or configure your operating system keychain.");
  }
}

function normalizedOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Credentials require HTTPS (or localhost for local development).");
  }
  if (url.username || url.password) throw new Error("Site URLs cannot include credentials.");
  return url.origin;
}

async function readFile(): Promise<VaultFile> {
  requireSystemEncryption();
  let content: string;
  try {
    content = await fs.readFile(vaultPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
    throw error;
  }
  const file: unknown = JSON.parse(content);
  if (!file || typeof file !== "object" || (file as VaultFile).version !== 1 || !Array.isArray((file as VaultFile).entries)) {
    throw new Error("Credential vault file is invalid; no data has been overwritten.");
  }
  return file as VaultFile;
}

async function writeFile(file: VaultFile): Promise<void> {
  const target = vaultPath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, JSON.stringify(file), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export function listSecrets(): Promise<readonly SecretVaultEntry[]> {
  return serialized(async () => (await readFile()).entries.map((item) => item.metadata));
}

export function saveSecret(input: SecretVaultWriteInput): Promise<SecretVaultEntry> {
  return serialized(async () => {
    const file = await readFile();
    const name = input.name.trim();
    const description = input.description.trim();
    const email = input.email.trim();
    if (!name || name.length > 128) throw new Error("Enter a name of up to 128 characters.");
    const origin = normalizedOrigin(input.origin);
    const previous = file.entries.find((entry) => entry.metadata.id === input.id);
    if (input.id && !previous) throw new Error("Credential not found.");
    const password = input.password;
    if (input.kind === "password" && !password && !(previous?.metadata.kind === "password" && previous.cipherText)) {
      throw new Error("Enter a password for this credential.");
    }
    const cipherText = input.kind === "passkey"
      ? null
      : password
        ? safeStorage.encryptString(password).toString("base64")
        : previous?.cipherText ?? null;
    const timestamp = new Date().toISOString();
    const metadata: SecretVaultEntry = {
      id: previous?.metadata.id ?? randomUUID(),
      name, description, origin, email, kind: input.kind,
      createdAt: previous?.metadata.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await writeFile({
      version: 1,
      entries: [...file.entries.filter((entry) => entry.metadata.id !== metadata.id), { metadata, cipherText }],
    });
    return metadata;
  });
}

export function removeSecret(id: string): Promise<void> {
  return serialized(async () => {
    const file = await readFile();
    if (!file.entries.some((entry) => entry.metadata.id === id)) return;
    await writeFile({ version: 1, entries: file.entries.filter((entry) => entry.metadata.id !== id) });
  });
}

/** Privileged desktop-only read. NEVER expose this return type through IPC, MCP, logs, or chat. */
export function getSecretForOrigin(id: string, pageUrl: string): Promise<{
  readonly metadata: SecretVaultEntry;
  readonly password: string | null;
}> {
  return serialized(async () => {
    const record = (await readFile()).entries.find((entry) => entry.metadata.id === id);
    if (!record) throw new Error("Credential not found.");
    if (normalizedOrigin(pageUrl) !== record.metadata.origin) {
      throw new Error("Credential site does not match the browser tab. Navigate to the saved site first.");
    }
    return {
      metadata: record.metadata,
      password: record.cipherText ? safeStorage.decryptString(Buffer.from(record.cipherText, "base64")) : null,
    };
  });
}
