import * as Schema from "effect/Schema";

export const Skill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  content: Schema.String,
});
export type Skill = typeof Skill.Type;

export const SkillListResult = Schema.Struct({ skills: Schema.Array(Skill) });
export type SkillListResult = typeof SkillListResult.Type;

export const SkillSaveInput = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  content: Schema.String,
});
export type SkillSaveInput = typeof SkillSaveInput.Type;

export const SkillDeleteInput = Schema.Struct({ name: Schema.String });
export type SkillDeleteInput = typeof SkillDeleteInput.Type;

export class SkillError extends Schema.TaggedErrorClass<SkillError>()("SkillError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
