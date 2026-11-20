import type { EnvironmentId, TeamMessage } from "@sparky/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { LoaderCircleIcon, ReplyIcon, SmilePlusIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { teamsEnvironment } from "../../state/teams";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTime, mergeById, REACTION_EMOJIS, writeLastSeen } from "./teamsLogic";
import { teamsFailureMessage } from "./teamsErrors";
import { useTeamPolling } from "./useTeamPolling";

const MESSAGE_POLL_INTERVAL_MS = 3_000;
const NEAR_BOTTOM_PX = 80;
const QUOTE_MAX_CHARS = 140;

/** Messages of every thread this session has loaded, for unread counts in the thread list. */
const threadMessageCache = new Map<string, readonly TeamMessage[]>();

export function teamThreadKey(projectId: string, threadId: string): string {
  return `${projectId}#${threadId}`;
}

export function cachedThreadMessages(threadKey: string): readonly TeamMessage[] | undefined {
  return threadMessageCache.get(threadKey);
}

function firstLine(body: string): string {
  const line =
    body
      .split(/\r?\n/)
      .find((entry) => entry.trim().length > 0)
      ?.trim() ?? "";
  return Array.from(line).slice(0, QUOTE_MAX_CHARS).join("");
}

interface TeamMessageListProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly threadId: string;
  /** Incremented by the parent after the viewer posts, to fetch right away. */
  readonly refreshToken: number;
  readonly onReply: (message: TeamMessage) => void;
}

/**
 * Messages for one open thread. Polls every few seconds and merges results in place, so
 * only this component re-renders. The parent keys it by thread, so switching threads remounts it.
 */
export function TeamMessageList(props: TeamMessageListProps) {
  const { environmentId, projectId, threadId, refreshToken, onReply } = props;
  const threadKey = teamThreadKey(projectId, threadId);

  const query = useEnvironmentQuery(
    teamsEnvironment.listMessages({ environmentId, input: { projectId, threadId } }),
  );
  const toggleReaction = useAtomCommand(teamsEnvironment.toggleReaction, { reportFailure: false });

  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pickerMessageId, setPickerMessageId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);

  const refresh = query.refresh;
  useTeamPolling({ enabled: true, intervalMs: MESSAGE_POLL_INTERVAL_MS, run: refresh });

  useEffect(() => {
    if (refreshToken > 0) {
      refresh();
    }
  }, [refreshToken, refresh]);

  const incoming = query.data?.messages;
  useEffect(() => {
    if (incoming === undefined) {
      return;
    }
    setMessages((previous) => mergeById(previous, incoming));
    setLoaded(true);
  }, [incoming]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    threadMessageCache.set(threadKey, messages);
    const newest = messages[messages.length - 1];
    if (newest !== undefined) {
      writeLastSeen(threadKey, newest.id);
    }
  }, [messages, threadKey]);

  // Follow new messages only while the viewer is already near the bottom.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element !== null && pinnedToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  const messagesById = useMemo(() => {
    const map = new Map<string, TeamMessage>();
    for (const message of messages) {
      map.set(message.id, message);
    }
    return map;
  }, [messages]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    pinnedToBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
  };

  const handleToggleReaction = async (message: TeamMessage, emoji: string) => {
    setPickerMessageId(null);
    setActionError(null);
    const result = await toggleReaction({
      environmentId,
      input: { projectId, threadId, messageId: message.id, emoji },
    });
    if (AsyncResult.isSuccess(result)) {
      refresh();
      return;
    }
    setActionError(teamsFailureMessage(result, "Could not update the reaction."));
  };

  if (query.data === null && query.error !== null) {
    return <p className="p-4 text-sm text-destructive">{query.error}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 space-y-2.5 overflow-x-hidden overflow-y-auto px-3 py-3"
      >
        {!loaded ? (
          <div className="flex justify-center py-12">
            <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No messages yet.</p>
        ) : null}

        {messages.map((message) => {
          const parent =
            message.replyToId !== null ? messagesById.get(message.replyToId) : undefined;
          const pickerOpen = pickerMessageId === message.id;
          return (
            <article
              key={message.id}
              className="rounded-md border border-border/60 bg-background px-3 py-2"
            >
              <header className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 truncate font-medium text-foreground">
                  {message.author}
                </span>
                <time dateTime={message.createdAt} className="shrink-0">
                  {formatRelativeTime(message.createdAt)}
                </time>
              </header>

              {message.replyToId !== null ? (
                <div className="mt-1.5 min-w-0 border-l-2 border-border pl-2 text-xs text-muted-foreground">
                  {parent !== undefined ? (
                    <span className="block truncate">
                      {parent.author}: {firstLine(parent.body)}
                    </span>
                  ) : (
                    <span className="block truncate">Replying to an earlier message</span>
                  )}
                </div>
              ) : null}

              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
                {message.body}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {message.reactions.map((reaction) => (
                  <button
                    key={reaction.emoji}
                    type="button"
                    aria-pressed={reaction.reactedByViewer}
                    onClick={() => void handleToggleReaction(message, reaction.emoji)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                      reaction.reactedByViewer
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    <span>{reaction.emoji}</span>
                    <span className="tabular-nums">{reaction.count}</span>
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Add reaction"
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerMessageId(pickerOpen ? null : message.id)}
                  className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <SmilePlusIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onReply(message)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ReplyIcon className="size-3" />
                  Reply
                </button>
              </div>

              {pickerOpen ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {REACTION_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`React with ${emoji}`}
                      onClick={() => void handleToggleReaction(message, emoji)}
                      className="size-7 rounded-md text-base transition-colors hover:bg-accent"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {actionError !== null ? (
        <p className="px-3 pb-2 text-xs text-destructive">{actionError}</p>
      ) : null}
    </div>
  );
}
