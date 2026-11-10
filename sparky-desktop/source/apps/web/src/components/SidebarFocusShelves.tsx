import { ChevronRightIcon, LoaderIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@sparky/client-runtime/environment";
import type { SidebarThreadSummary } from "../types";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { isFocusWorkingThread } from "./Sidebar.focus.logic";
import { useSidebar } from "./ui/sidebar";

type ShelfKind = "working" | "parked";

const FocusShelf = memo(function FocusShelf({
  kind,
  threads,
}: {
  kind: ShelfKind;
  threads: readonly SidebarThreadSummary[];
}) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const setThreadParked = useUiStateStore((state) => state.setThreadParked);
  const openThread = useCallback(
    (thread: SidebarThreadSummary) => {
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [isMobile, navigate, setOpenMobile],
  );

  if (threads.length === 0) return null;
  const isParked = kind === "parked";
  const label = isParked ? "Parked" : "Working";

  return (
    <section className="px-3 py-1" data-testid={`focus-${kind}-shelf`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-expanded={expanded}
        aria-controls={`sparky-focus-${kind}-threads`}
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRightIcon
          className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        {!isParked ? <LoaderIcon className="size-3.5 animate-spin text-sky-500" aria-hidden="true" /> : null}
        <span className="flex-1 font-medium">{label}</span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
          {threads.length}
        </span>
      </button>
      {expanded ? (
        <ul id={`sparky-focus-${kind}-threads`} className="mt-0.5 space-y-0.5 pl-2">
          {threads.map((thread) => {
            const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
            const running = isFocusWorkingThread(thread);
            return (
              <li key={threadKey} className="flex min-w-0 items-center gap-1 rounded-md hover:bg-accent/60">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-xs"
                  onClick={() => openThread(thread)}
                  title={thread.title}
                  data-testid={`focus-${kind}-thread-${thread.id}`}
                >
                  {running ? <LoaderIcon className="size-3 shrink-0 animate-spin text-sky-500" aria-label="Working" /> : null}
                  <span className="truncate">{thread.title}</span>
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={`${isParked ? "Restore" : "Park"} ${thread.title}`}
                  onClick={() => setThreadParked(threadKey, !isParked)}
                >
                  {isParked ? "Restore" : "Park"}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
});

export const SidebarFocusShelves = memo(function SidebarFocusShelves({
  working,
  parked,
}: {
  working: readonly SidebarThreadSummary[];
  parked: readonly SidebarThreadSummary[];
}) {
  if (working.length === 0 && parked.length === 0) return null;
  return (
    <div className="border-t border-border/40 pt-1" aria-label="Focus thread shelves">
      <FocusShelf kind="working" threads={working} />
      <FocusShelf kind="parked" threads={parked} />
    </div>
  );
});
