import * as Schema from "effect/Schema";

export const MemoryScope = Schema.Literals(["global", "project"]);
export type MemoryScope = typeof MemoryScope.Type;

export const Memory = Schema.Struct({
  id: Schema.String,
  scope: MemoryScope,
  title: Schema.String,
  content: Schema.String,
  category: Schema.String,
  importance: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  source: Schema.optional(Schema.String),
});
export type Memory = typeof Memory.Type;

export const MemoryListInput = Schema.Struct({
  query: Schema.optional(Schema.String),
});
export type MemoryListInput = typeof MemoryListInput.Type;

export const MemoryListResult = Schema.Struct({
  memories: Schema.Array(Memory),
});
export type MemoryListResult = typeof MemoryListResult.Type;

export const MemoryAddInput = Schema.Struct({
  scope: MemoryScope,
  title: Schema.String,
  content: Schema.String,
  category: Schema.optional(Schema.String),
  importance: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
  source: Schema.optional(Schema.String),
});
export type MemoryAddInput = typeof MemoryAddInput.Type;

export const MemoryUpdateInput = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
  category: Schema.optional(Schema.String),
  importance: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
  source: Schema.optional(Schema.String),
});
export type MemoryUpdateInput = typeof MemoryUpdateInput.Type;

export const MemoryDeleteInput = Schema.Struct({
  id: Schema.String,
});
export type MemoryDeleteInput = typeof MemoryDeleteInput.Type;

export class MemoryError extends Schema.TaggedErrorClass<MemoryError>()("MemoryError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
