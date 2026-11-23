import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

/**
 * Upper bound for each side of the completed round sent to the suggestion
 * agent. The server trims again, so this only keeps request payloads small.
 */
export const PROMPT_SUGGESTION_MAX_ROUND_CHARS = 4_000;

/** Maximum length of a suggested next prompt, in characters. */
export const PROMPT_SUGGESTION_MAX_CHARS = 240;

export const PromptSuggestionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  /** The user's message that started the completed round. */
  userMessage: Schema.String,
  /** The assistant's final reply for that round. */
  assistantMessage: Schema.String,
});
export type PromptSuggestionInput = typeof PromptSuggestionInput.Type;

export const PromptSuggestionResult = Schema.Struct({
  /** Empty when the agent had no confident guess for the next prompt. */
  suggestion: Schema.String,
});
export type PromptSuggestionResult = typeof PromptSuggestionResult.Type;
