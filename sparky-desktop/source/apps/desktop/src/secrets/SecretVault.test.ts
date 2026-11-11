// @effect-diagnostics nodeBuiltinImport:off - OS vault integration tests need isolated temporary files.
// @effect-diagnostics globalDate:off - Test timestamps are wall-clock timestamps.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Vault from "./SecretVault.ts";

const mock = vi.hoisted(() => ({
  directory: "/invalid",
  available: true,
  backend: "gnome_libsecret",
}));
vi.mock("electron", () => ({
  app: { getPath: () => mock.directory },
  safeStorage: {
    isEncryptionAvailable: () => mock.available,
    getSelectedStorageBackend: () => mock.backend,
    encryptString: (plain: string) => Buffer.from("ciphertext:" + plain, "utf8"),
    decryptString: (encoded: Buffer) => encoded.toString("utf8").slice("ciphertext:".length),
  },
}));

const example = {
  name: "Example",
  kind: "password" as const,
  description: "Test account",
  origin: "https://example.com/login",
  email: "user@example.com",
  password: "super-private-secret",
};

describe("local encrypted credential vault", () => {
  beforeEach(async () => {
    mock.directory = await fs.mkdtemp(path.join(os.tmpdir(), "sparky-secrets-test-"));
    mock.backend = "gnome_libsecret";
    mock.available = true;
  });
  afterEach(async () => {
    await fs.rm(mock.directory, { recursive: true, force: true });
  });

  it("stores encrypted values and exposes only metadata in listings", async () => {
    const entry = await Vault.saveSecret(example);
    expect(entry.origin).toBe("https://example.com");
    expect(JSON.stringify(await Vault.listSecrets())).not.toContain(example.password);
    const rawFile = await fs.readFile(path.join(mock.directory, "sparky-secret-vault-v1.json"), "utf8");
    expect(rawFile).not.toContain(example.password);
    const retrieved = await Vault.getSecretForOrigin(entry.id, "https://example.com/dashboard");
    expect(retrieved.password).toBe(example.password);
    expect(retrieved.metadata.name).toBe("Example");
  });

  it("never reveals a saved credential to another site", async () => {
    const entry = await Vault.saveSecret(example);
    await expect(Vault.getSecretForOrigin(entry.id, "https://attacker.example")).rejects.toThrow(
      "Credential site does not match",
    );
    await expect(Vault.getSecretForOrigin(entry.id, "http://example.com")).rejects.toThrow();
  });

  it("refuses the insecure Linux basic_text backend", async () => {
    mock.backend = "basic_text";
    await expect(Vault.saveSecret(example)).rejects.toThrow("Secure credential storage is unavailable");
  });

  it("stores native passkeys as metadata-only references", async () => {
    const entry = await Vault.saveSecret({
      name: "Passkey test",
      origin: "https://example.com",
      kind: "passkey",
      email: "user@example.com",
      description: "",
    });
    expect((await Vault.getSecretForOrigin(entry.id, "https://example.com")).password).toBeNull();
    expect((await Vault.listSecrets())[0]?.kind).toBe("passkey");
  });
});
