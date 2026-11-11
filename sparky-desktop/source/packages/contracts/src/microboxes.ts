import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

/** User-facing VM API. Never expose host commands, paths, or QMP to clients. */
const BoxId = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{8,64}$/u));
const ImageId = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,48}$/u));
export const MicroboxCreateInput = Schema.Struct({
  threadId: ThreadId,
  imageId: ImageId,
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
  memoryMiB: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 8192 }))),
  cpus: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
  internet: Schema.optionalKey(Schema.Boolean),
});
export type MicroboxCreateInput = typeof MicroboxCreateInput.Type;
export const MicroboxListInput = Schema.Struct({ threadId: ThreadId });
export const MicroboxTarget = Schema.Struct({ threadId: ThreadId, boxId: BoxId });
export type MicroboxTarget = typeof MicroboxTarget.Type;
export const MicroboxClickInput = Schema.Struct({
  ...MicroboxTarget.fields,
  x: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
  y: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
  button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
});
export const MicroboxKeyInput = Schema.Struct({
  ...MicroboxTarget.fields,
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
});
export const MicroboxTypeInput = Schema.Struct({
  ...MicroboxTarget.fields,
  text: Schema.String.check(Schema.isMaxLength(4096)),
});
export const MicroboxStatus = Schema.Struct({
  boxId: BoxId,
  threadId: ThreadId,
  imageId: ImageId,
  name: Schema.String,
  state: Schema.Literals(["starting", "running", "stopping", "stopped", "error"]),
  memoryMiB: Schema.Int,
  cpus: Schema.Int,
  internet: Schema.Boolean,
  startedAt: Schema.String,
});
export type MicroboxStatus = typeof MicroboxStatus.Type;
export const MicroboxImage = Schema.Struct({
  imageId: ImageId,
  name: Schema.String,
  kind: Schema.Literals(["linux-kernel", "disk", "installer-iso"]),
  architecture: Schema.Literals(["x86_64", "aarch64"]),
});
export type MicroboxImage = typeof MicroboxImage.Type;
export const MicroboxSnapshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
});
export type MicroboxSnapshot = typeof MicroboxSnapshot.Type;

export const MicroboxErrorCode = Schema.Literals([
  "disabled", "forbidden", "not-found", "limit", "image-missing", "unsupported",
  "launch-failed", "io-error", "protocol-error", "invalid-input", "busy",
]);
export class MicroboxError extends Schema.TaggedErrorClass<MicroboxError>()(
  "MicroboxError",
  { code: MicroboxErrorCode, message: Schema.String },
) {}
