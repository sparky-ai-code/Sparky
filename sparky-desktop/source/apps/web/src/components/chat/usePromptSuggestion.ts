import { useEffect, useMemo, useRef } from "react";
import type { ModelSelection } from "@sparky/contracts";

import { textGenerationEnvironment } from "~/state/textGeneration";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePromptSuggestionStore } from "~/state/promptSuggestionStore";
import type { Thread } from "~/types";

import { getCompletedPromptRound, type CompletedPromptRound } from "./promptSuggestionRound";

interface UsePromptSuggestionInput {
  /** The thread shown in the composer. Null for drafts. */
  readonly thread: Thread | undefined;
  /** Working directory the suggestion agent runs in. */
  readonly cwd: string | null;
  /** False while the composer is busy, waiting on an approval, or disconnected. */
  readonly enabled: boolean;
}

/**
 * Returns the predicted next prompt for the thread's latest completed round.
 *
 * Each completed round triggers one background suggestion request. Results are
 * cached per round, so the agent runs once per turn and never blocks the composer.
 */
export function usePromptSuggestion(input: UsePromptSuggestionInput): string | null {
  const { thread, cwd, enabled } = input;
  const round = useMemo(() => getCompletedPromptRound(thread), [thread]);
  const roundRef = useRef<CompletedPromptRound | null>(round);
  roundRef.current = round;

  const modelSelection: ModelSelection | undefined = thread?.modelSelection;
  const environmentId = thread?.environmentId ?? null;
  const roundKey = round?.key ?? null;
  const entry = usePromptSuggestionStore((state) =>
    roundKey ? state.entries[roundKey] : undefined,
  );
  const setEntry = usePromptSuggestionStore((state) => state.setEntry);
  const generate = useAtomCommand(textGenerationEnvironment.generatePromptSuggestion, {
    reportFailure: false,
    reportDefect: false,
  });

  useEffect(() => {
    const currentRound = roundRef.current;
    if (!enabled || !currentRound || !environmentId || !cwd || !modelSelection) return;
    if (usePromptSuggestionStore.getState().entries[currentRound.key]) return;

    setEntry(currentRound.key, { status: "pending" });
    void generate({
      environmentId,
      input: {
        cwd,
        modelSelection,
        userMessage: currentRound.userMessage,
        assistantMessage: currentRound.assistantMessage,
      },
    }).then((result) => {
      if (result._tag === "Success") {
        const suggestion = result.value.suggestion.trim();
        setEntry(
          currentRound.key,
          suggestion ? { status: "ready", suggestion } : { status: "empty" },
        );
        return;
      }
      setEntry(currentRound.key, { status: "empty" });
    });
  }, [enabled, environmentId, cwd, modelSelection, roundKey, generate, setEntry]);

  if (!round || entry?.status !== "ready") return null;
  return entry.suggestion;
}
