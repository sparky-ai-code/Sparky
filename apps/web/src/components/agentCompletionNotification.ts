import type { TurnId } from "@sparky/contracts";
import type { ChatMessage } from "../types";

export const AGENT_NOTIFICATION_MAX_LINES = 7;

export function buildAgentNotificationBody(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, AGENT_NOTIFICATION_MAX_LINES)
    .join("\n");
}

export function resolveAssistantMessageForTurn(
  messages: ReadonlyArray<ChatMessage>,
  turnId: TurnId,
): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.turnId === turnId) {
      return message;
    }
  }
  return null;
}

export function isAgentTurnCompletion(input: {
  readonly previousTurnId: TurnId | null;
  readonly previousSettled: boolean;
  readonly currentTurnId: TurnId;
  readonly currentSettled: boolean;
}): boolean {
  return (
    input.previousTurnId === input.currentTurnId && !input.previousSettled && input.currentSettled
  );
}
