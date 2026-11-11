import * as Schema from "effect/Schema";

/** Public metadata only: passwords and passkey private keys are never serialized in this type. */
export const SecretVaultEntrySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  origin: Schema.String,
  email: Schema.String,
  kind: Schema.Literals(["password", "passkey"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type SecretVaultEntry = typeof SecretVaultEntrySchema.Type;

export const SecretVaultWriteInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  description: Schema.String,
  origin: Schema.String,
  email: Schema.String,
  kind: Schema.Literals(["password", "passkey"]),
  /** Only accepted at the privileged desktop IPC boundary; never sent to MCP or the agent. */
  password: Schema.optional(Schema.String),
});
export type SecretVaultWriteInput = typeof SecretVaultWriteInputSchema.Type;

export const SecretVaultFillInputSchema = Schema.Struct({
  /** Credential ID or friendly name; never plaintext. */
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  emailLocator: Schema.optional(Schema.String),
  passwordLocator: Schema.optional(Schema.String),
  passkeyLocator: Schema.optional(Schema.String),
});
export type SecretVaultFillInput = typeof SecretVaultFillInputSchema.Type;

export const SecretVaultUseResultSchema = Schema.Struct({
  kind: Schema.Literals(["password", "passkey"]),
  status: Schema.Literals(["filled", "awaiting-user"]),
});
export type SecretVaultUseResult = typeof SecretVaultUseResultSchema.Type;
