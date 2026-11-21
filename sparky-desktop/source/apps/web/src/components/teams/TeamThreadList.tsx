import type { TeamProject, TeamThread } from "@sparky/contracts";
import { LoaderCircleIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "../../lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { cachedThreadMessages, teamThreadKey } from "./TeamMessageList";
import { countUnread, formatRelativeTime, readLastSeenMap } from "./teamsLogic";

interface TeamThreadListProps {
  readonly projects: readonly TeamProject[];
  readonly projectId: string | null;
  readonly onSelectProject: (projectId: string) => void;
  readonly threads: readonly TeamThread[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedThreadId: string | null;
  readonly onSelectThread: (threadId: string) => void;
  readonly viewerLogin: string | null;
}

function byUpdatedAtDesc(a: TeamThread, b: TeamThread): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

export function TeamThreadList(props: TeamThreadListProps) {
  const {
    projects,
    projectId,
    onSelectProject,
    threads,
    loading,
    error,
    selectedThreadId,
    onSelectThread,
    viewerLogin,
  } = props;

  const sortedThreads = useMemo(() => [...threads].sort(byUpdatedAtDesc), [threads]);
  // Read per render. Cheap, and it picks up the last-seen id written by the message list.
  const lastSeen = readLastSeenMap();

  return (
    <div className="flex min-h-0 flex-col gap-2 p-2">
      {projects.length > 0 ? (
        <Select
          value={projectId}
          onValueChange={(value) => {
            if (typeof value === "string") {
              onSelectProject(value);
            }
          }}
        >
          <SelectTrigger size="sm" aria-label="Team project" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent matchTriggerWidth>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.nameWithOwner}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {error !== null ? <p className="px-1 text-xs text-destructive">{error}</p> : null}

      {loading ? (
        <div className="flex justify-center py-8">
          <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : sortedThreads.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-muted-foreground">No threads yet.</p>
      ) : (
        <ul className="flex max-h-[46vh] flex-col gap-0.5 overflow-y-auto overflow-x-hidden lg:max-h-[460px]">
          {sortedThreads.map((thread) => {
            const selected = thread.id === selectedThreadId;
            const key = projectId !== null ? teamThreadKey(projectId, thread.id) : thread.id;
            const unread = countUnread(
              cachedThreadMessages(key) ?? [],
              lastSeen[key] ?? null,
              viewerLogin,
            );
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelectThread(thread.id)}
                  className={cn(
                    "flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent",
                    selected && "bg-accent",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {thread.title}
                    </span>
                    {unread > 0 ? (
                      <span
                        aria-label={`${unread} unread`}
                        className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] leading-4 font-medium text-primary-foreground"
                      >
                        {unread}
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {thread.author} · {formatRelativeTime(thread.updatedAt)}
                    {thread.state === "closed" ? " · closed" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
