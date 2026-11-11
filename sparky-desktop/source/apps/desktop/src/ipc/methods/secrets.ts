import {
  SecretVaultEntrySchema,
  SecretVaultWriteInputSchema,
  SecretVaultFillInputSchema,
  SecretVaultUseResultSchema,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Vault from "../../secrets/SecretVault.ts";
import * as PreviewManager from "../../preview/Manager.ts";

// Renderer receives only public metadata. Decryption happens in the privileged desktop process.
class SecretVaultOperationError extends Schema.TaggedErrorClass<SecretVaultOperationError>()(
  "SecretVaultOperationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Saved login operation failed.";
  }
}
const attempt = <T>(work: () => Promise<T>) => Effect.tryPromise({
  try: work,
  catch: (cause) => new SecretVaultOperationError({ cause }),
});

export const list = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SECRET_VAULT_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(SecretVaultEntrySchema),
  handler: () => attempt(() => Vault.listSecrets()),
});

export const save = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SECRET_VAULT_SAVE_CHANNEL,
  payload: SecretVaultWriteInputSchema,
  result: SecretVaultEntrySchema,
  handler: (input) => attempt(() => Vault.saveSecret(input)),
});

export const remove = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SECRET_VAULT_REMOVE_CHANNEL,
  payload: Schema.Struct({ id: Schema.String }),
  result: Schema.Void,
  handler: ({ id }) => attempt(() => Vault.removeSecret(id)),
});

export const use = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SECRET_VAULT_USE_CHANNEL,
  payload: Schema.Struct({ tabId: Schema.String, input: SecretVaultFillInputSchema }),
  result: SecretVaultUseResultSchema,
  handler: Effect.fn("desktop.ipc.secrets.use")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    const url = yield* manager.automationPageUrl(tabId);
    if (!url) return yield* Effect.fail(new SecretVaultOperationError({ cause: "Browser site is unavailable." }));
    const secret = yield* attempt(() => Vault.getSecretForOrigin(input.id, url));
    // A second origin check runs inside the browser control session, preventing navigation races.
    return yield* manager.automationUseSecret(tabId, {
      origin: secret.metadata.origin,
      kind: secret.metadata.kind,
      email: secret.metadata.email,
      password: secret.password,
      ...(input.emailLocator === undefined ? {} : { emailLocator: input.emailLocator }),
      ...(input.passwordLocator === undefined ? {} : { passwordLocator: input.passwordLocator }),
      ...(input.passkeyLocator === undefined ? {} : { passkeyLocator: input.passkeyLocator }),
    });
  }),
});

export const isProtected = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SECRET_VAULT_IS_PROTECTED_CHANNEL,
  payload: Schema.Struct({ tabId: Schema.String }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.secrets.isProtected")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationIsProtected(tabId);
  }),
});

export const methods = [list, save, remove, use, isProtected] as const;
