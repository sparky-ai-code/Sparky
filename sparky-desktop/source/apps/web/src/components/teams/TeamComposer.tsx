import type { EnvironmentId, TeamMessage, TeamThread } from "@sparky/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { LoaderCircleIcon, SendIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { teamsEnvironment } from "../../state/teams";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { teamsFailureMessage } from "./teamsErrors";

interface TeamComposerProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: string | null;
  /** Selected thread. Null means the next send starts a new thread. */
  readonly threadId: string | null;
  readonly replyTo: TeamMessage | null;
  readonly draft: string;
  /** Incremented by the parent to move focus into the textarea. */
  readonly focusRequest: number;
  readonly onDraftChange: (value: string) => void;
  readonly onClearReply: () => void;
  readonly onThreadCreated: (thread: TeamThread) => void;
  readonly onMessagePosted: () => void;
  readonly onOpenProjects: () => void;
}

function firstLine(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow: reset to auto so the box can also shrink, then fit the content.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (element === null) {
      return;
    }
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    if (focusRequest > 0) {
      textareaRef.current?.focus();
    }
  }, [focusRequest]);

  if (projectId === null) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
        <span>No project yet.</span>
        <Button type="button" size="sm" variant="outline" onClick={onOpenProjects}>
          Add project
        </Button>
      </div>
    );
  }

  const canSend = draft.trim().length > 0 && !sending;

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || sending) {
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
          onClearReply();
          onMessagePosted();
        } else {
          setError(teamsFailureMessage(result, "Could not send the message."));
        }
      } else {
        const result = await createThread({ environmentId, input: { projectId, body } });
        if (AsyncResult.isSuccess(result)) {
          onDraftChange("");
          onThreadCreated(result.value);
        } else {
          setError(teamsFailureMessage(result, "Could not start the thread."));
        }
      }
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-2 shadow-xs">
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
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={2}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message your team…"
          aria-label="Message your team"
          className="max-h-48 min-h-12 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <Button
          type="button"
          size="icon"
          aria-label="Send message"
          disabled={!canSend}
          onClick={() => void send()}
        >
          {sending ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
        </Button>
      </div>
      {error !== null ? <p className="px-2 pt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
