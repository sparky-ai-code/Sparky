import type { ScopedThreadRef } from "@sparky/contracts";
import { scopedThreadKey, scopeThreadRef } from "@sparky/client-runtime/environment";
import { XIcon } from "lucide-react";
import { useEffect } from "react";
import { SidebarInset } from "./components/ui/sidebar";
import ChatView, { type ChatViewProps } from "./components/ChatView";
import { sameSplitChatThread, useSplitChatStore, type SplitChatPosition } from "./splitChatStore";

function currentRefForProps(props: ChatViewProps): ScopedThreadRef | null {
  return props.routeKind === "server" ? scopeThreadRef(props.environmentId, props.threadId) : null;
}

function paneProps(props: ChatViewProps, ref: ScopedThreadRef, side: SplitChatPosition): ChatViewProps {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
    routeKind: "server",
    ...(props.onDiffPanelOpen ? { onDiffPanelOpen: props.onDiffPanelOpen } : {}),
    forceExpandedMobileComposer: false,
    reserveTitleBarControlInset: side.endsWith("right") && props.reserveTitleBarControlInset !== false,
  };
}

export function SplitChatView(props: ChatViewProps) {
  const currentRef = currentRefForProps(props);
  const panes = useSplitChatStore((state) => state.panes);
  const clearSplit = useSplitChatStore((state) => state.clearSplit);
  const paneEntries = (Object.entries(panes) as [SplitChatPosition, ScopedThreadRef][])
    .filter(([, ref]) => Boolean(ref));
  const isSplit = currentRef !== null && paneEntries.length >= 2 && paneEntries.some(([, ref]) => sameSplitChatThread(ref, currentRef));

  useEffect(() => {
    if (currentRef !== null && paneEntries.length > 0 && !paneEntries.some(([, ref]) => sameSplitChatThread(ref, currentRef))) {
      clearSplit();
    }
  }, [clearSplit, currentRef, panes]);

  if (!isSplit || !currentRef) {
    return (
      <SidebarInset className="relative h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ChatView {...props} />
      </SidebarInset>
    );
  }

  return (
    <SidebarInset
      className="relative flex h-svh min-h-0 min-w-0 flex-1 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh"
      data-split-chat-current-thread="true"
      data-environment-id={currentRef.environmentId}
      data-thread-id={currentRef.threadId}
      aria-label="Split chat view"
    >
      <div className={`relative grid min-h-0 min-w-0 flex-1 grid-cols-2 overflow-hidden ${paneEntries.length <= 2 ? "grid-rows-1" : "grid-rows-2"}`}>
        {paneEntries.map(([position, ref]) => (
          <div
            key={position}
            className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden ${position.includes("right") ? "border-l" : ""} ${position.startsWith("bottom") ? "border-t" : ""} border-border/80`}
            style={{ gridColumn: position.endsWith("left") ? 1 : 2, gridRow: position.startsWith("top") ? 1 : 2 }}
            data-split-chat-pane={position}
            data-testid={`split-chat-${position}`}
          >
            <ChatView key={scopedThreadKey(ref)} {...paneProps(props, ref, position)} />
          </div>
        ))}
      </div>
      <button
        type="button"
        aria-label="Close split chat view"
        title="Close split chat view"
        onClick={clearSplit}
        className="absolute right-2 top-[calc(var(--workspace-topbar-height)+0.5rem)] z-40 inline-flex size-7 items-center justify-center rounded-lg border border-border/70 bg-card/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <XIcon className="size-3.5" />
      </button>
    </SidebarInset>
  );
}
