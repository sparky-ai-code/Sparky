import type { MessageId, TurnId } from "@sparky/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../types";
import {
  buildAgentNotificationBody,
  isAgentTurnCompletion,
  resolveAssistantMessageForTurn,
} from "./agentCompletionNotification";

const makeAssistantMessage = (turnId: string, text: string): ChatMessage =>
  ({
    id: `${turnId}-message` as MessageId,
    role: "assistant" as const,
    text,
    turnId: turnId as TurnId,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  }) as ChatMessage;

describe("buildAgentNotificationBody", () => {
  it("returns the first seven non-empty lines", () => {
    expect(
      buildAgentNotificationBody("\nOne\r\n\r\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight"),
    ).toBe("One\nTwo\nThree\nFour\nFive\nSix\nSeven");
  });

  it("returns an empty body for whitespace-only responses", () => {
    expect(buildAgentNotificationBody(" \n\t ")).toBe("");
  });
});

describe("resolveAssistantMessageForTurn", () => {
  it("selects the final assistant message for the completed turn", () => {
    const earlier = makeAssistantMessage("turn-1", "Earlier");
    const final = makeAssistantMessage("turn-2", "Final");
    expect(resolveAssistantMessageForTurn([earlier, final], "turn-2" as TurnId)).toBe(final);
  });

  it("does not use an assistant message from another turn", () => {
    expect(
      resolveAssistantMessageForTurn(
        [makeAssistantMessage("turn-1", "Earlier")],
        "turn-2" as TurnId,
      ),
    ).toBeNull();
  });
});

describe("isAgentTurnCompletion", () => {
  it("only fires when the same turn changes from unsettled to settled", () => {
    expect(
      isAgentTurnCompletion({
        previousTurnId: "turn-1" as TurnId,
        previousSettled: false,
        currentTurnId: "turn-1" as TurnId,
        currentSettled: true,
      }),
    ).toBe(true);
    expect(
      isAgentTurnCompletion({
        previousTurnId: "turn-1" as TurnId,
        previousSettled: true,
        currentTurnId: "turn-1" as TurnId,
        currentSettled: true,
      }),
    ).toBe(false);
    expect(
      isAgentTurnCompletion({
        previousTurnId: "turn-1" as TurnId,
        previousSettled: false,
        currentTurnId: "turn-2" as TurnId,
        currentSettled: true,
      }),
    ).toBe(false);
  });
});
