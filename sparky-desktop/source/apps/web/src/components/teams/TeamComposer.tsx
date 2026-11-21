import type {
  EnvironmentId,
  ServerProviderSkill,
  TeamMessage,
  TeamThread,
} from "@sparky/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { PlusIcon, XIcon } from "../Hugeicons";
import { useEffect, useRef, useState } from "react";

import { ComposerPrimaryActions } from "../chat/ComposerPrimaryActions";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { teamsEnvironment } from "../../state/teams";
import { useAtomCommand } from "../../state/use-atom-command";
import { teamsFailureMessage } from "./teamsErrors";

interface TeamComposerProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: string | null;
  /** Selected thread. Null means the next send starts a new thread. */
  readonly threadId: string | null;
  readonly replyTo: TeamMessage | null;
  readonly draft: string;
  /** Incremented by the parent to move focus into the editor. */
  readonly focusRequest: number;
  readonly onDraftChange: (value: string) => void;
  readonly onClearReply: () => void;
  readonly onThreadCreated: (thread: TeamThread) => void;
  readonly onMessagePosted: () => void;
  readonly onOpenProjects: () => void;
}

// Stable empty values, so the editor does not see new props on every render.
const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const NO_TERMINAL_CONTEXTS: ReadonlyArray<never> = [];
const noop = () => undefined;

function firstLine(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

/**
 * Teams chat box. Uses the same prompt editor and send button as the main Sparky composer,
 * so typing, mentions, and send behave the same way.
 */
export function TeamComposer(props: TeamComposerProps) {
  const {
    environmentId,
    projectId,
    threadId,
    replyTo,
    draft,
    focusRequest,
    onDraftChange,
    onClearReply,
    onThreadCreated,
    onMessagePosted,
    onOpenProjects,
  } = props;

  const postMessage = useAtomCommand(teamsEnvironment.postMessage, { reportFailure: false });
  const createThread = useAtomCommand(teamsEnvironment.createThread, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);

  // The parent bumps focusRequest after a prompt chip or a reply. Move the caret to the end.
  const lastFocusRequest = useRef(0);
  useEffect(() => {
    if (focusRequest !== lastFocusRequest.current) {
      lastFocusRequest.current = focusRequest;
      setCursor(draft.length);
      editorRef.current?.focusAtEnd();
    }
  }, [focusRequest, draft]);

  const hasText = draft.trim().length > 0;

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || sending) {
      return;
    }
    if (projectId === null) {
      // Nothing to post to yet, so add a project first.
      onOpenProjects();
      return;
    }
    setSending(true);
    setError(null);
    try {
      if (threadId !== null) {
        const result = await postMessage({
          environmentId,
          input: {
            projectId,
            threadId,
            body,
            ...(replyTo !== null ? { replyToId: replyTo.id } : {}),
          },
        });
        if (AsyncResult.isSuccess(result)) {
          onDraftChange("");
          setCursor(0);
          onClearReply();
          onMessagePosted();
        } else {
          setError(teamsFailureMessage(result, "Could not send the message."));
        }
      } else {
        const result = await createThread({ environmentId, input: { projectId, body } });
        if (AsyncResult.isSuccess(result)) {
          onDraftChange("");
          setCursor(0);
          onThreadCreated(result.value);
        } else {
          setError(teamsFailureMessage(result, "Could not start the thread."));
        }
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="mx-auto w-full min-w-0"
      data-teams-composer-form="true"
    >
      {replyTo !== null ? (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            Replying to {replyTo.author}: {firstLine(replyTo.body)}
          </span>
          <button
            type="button"
            aria-label="Cancel reply"
            onClick={onClearReply}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-2 rounded-full border border-border bg-card px-2 py-1.5">
        <button
          type="button"
          aria-label="Add"
          disabled
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 disabled:pointer-events-none"
        >
          <PlusIcon className="size-4" />
        </button>
        <div className="relative min-w-0 flex-1">
          <ComposerPromptEditor
            editorRef={editorRef}
            value={draft}
            cursor={cursor}
            terminalContexts={NO_TERMINAL_CONTEXTS}
            skills={NO_SKILLS}
            disabled={sending}
            placeholder="Message"
            className="min-h-0 max-h-32 py-1"
            onRemoveTerminalContext={noop}
            onChange={(nextValue, nextCursor) => {
              setCursor(nextCursor);
              onDraftChange(nextValue);
            }}
            onCommandKeyDown={(key, event) => {
              if (key === "Enter" && !event.shiftKey) {
                void send();
                return true;
              }
              return false;
            }}
            onPaste={noop}
          />
        </div>
        <ComposerPrimaryActions
          compact
          pendingAction={null}
          isRunning={false}
          showPlanFollowUpPrompt={false}
          promptHasText={hasText}
          isSendBusy={sending}
          isConnecting={false}
          isEnvironmentUnavailable={false}
          isPreparingWorktree={false}
          hasSendableContent={hasText}
          preserveComposerFocusOnPointerDown
          onPreviousPendingQuestion={noop}
          onInterrupt={noop}
          onImplementPlanInNewThread={noop}
        />
      </div>
      {error !== null ? <p className="px-2 pt-1 text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
