import { PROMPT_SUGGESTION_MAX_ROUND_CHARS } from "@sparky/contracts";

/** The subset of a thread the suggestion logic reads. */
export interface PromptSuggestionThreadLike {
  readonly id: string;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: string;
    readonly assistantMessageId: string | null;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly turnId: string | null;
    readonly streaming: boolean;
  }>;
}

export interface CompletedPromptRound {
  /** Stable key for the thread's latest completed turn. */
  readonly key: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly userMessage: string;
  readonly assistantMessage: string;
}

export function promptSuggestionKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function clampRoundText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= PROMPT_SUGGESTION_MAX_ROUND_CHARS
    ? trimmed
    : trimmed.slice(0, PROMPT_SUGGESTION_MAX_ROUND_CHARS);
}

/**
 * Returns the thread's latest round when it has completed with a settled
 * assistant reply, or null while it is still running or has nothing to predict from.
 */
export function getCompletedPromptRound(
  thread: PromptSuggestionThreadLike | null | undefined,
): CompletedPromptRound | null {
  const latestTurn = thread?.latestTurn;
  if (!thread || !latestTurn || latestTurn.state !== "completed") return null;

  const turnMessages = thread.messages.filter((message) => message.turnId === latestTurn.turnId);
  const assistantById = latestTurn.assistantMessageId
    ? thread.messages.find((message) => message.id === latestTurn.assistantMessageId)
    : undefined;
  const assistant =
    assistantById ?? [...turnMessages].reverse().find((message) => message.role === "assistant");
  const user = [...turnMessages].reverse().find((message) => message.role === "user");

  if (!assistant || assistant.role !== "assistant" || assistant.streaming) return null;
  if (!user || assistant.text.trim().length === 0 || user.text.trim().length === 0) return null;

  return {
    key: promptSuggestionKey(thread.id, latestTurn.turnId),
    threadId: thread.id,
    turnId: latestTurn.turnId,
    userMessage: clampRoundText(user.text),
    assistantMessage: clampRoundText(assistant.text),
  };
}
