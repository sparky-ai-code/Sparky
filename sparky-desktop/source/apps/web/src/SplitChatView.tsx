import type { ScopedThreadRef } from "@sparky/contracts";
import { scopedThreadKey, scopeThreadRef } from "@sparky/client-runtime/environment";
import { XIcon } from "lucide-react";
import { useEffect } from "react";
import { SidebarInset } from "./components/ui/sidebar";
import ChatView, { type ChatViewProps } from "./components/ChatView";
import { sameSplitChatThread, useSplitChatStore, type SplitChatSide } from "./splitChatStore";

function currentRefForProps(props: ChatViewProps): ScopedThreadRef | null {
  return props.routeKind === "server" ? scopeThreadRef(props.environmentId, props.threadId) : null;
}

function paneProps(props: ChatViewProps, ref: ScopedThreadRef, side: SplitChatSide): ChatViewProps {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
    routeKind: "server",
    ...(props.onDiffPanelOpen ? { onDiffPanelOpen: props.onDiffPanelOpen } : {}),
    forceExpandedMobileComposer: false,
    reserveTitleBarControlInset: side === "right" && props.reserveTitleBarControlInset !== false,
  };
}

export function SplitChatView(props: ChatViewProps) {
  const currentRef = currentRefForProps(props);
  const left = useSplitChatStore((state) => state.left);
  const right = useSplitChatStore((state) => state.right);
  const clearSplit = useSplitChatStore((state) => state.clearSplit);
  const isSplit =
    currentRef !== null &&
    left !== null &&
    right !== null &&
    !sameSplitChatThread(left, right) &&
    (sameSplitChatThread(currentRef, left) || sameSplitChatThread(currentRef, right));

  useEffect(() => {
    if (
      currentRef !== null &&
      left !== null &&
      right !== null &&
      !sameSplitChatThread(currentRef, left) &&
      !sameSplitChatThread(currentRef, right)
    ) {
      clearSplit();
    }
  }, [clearSplit, currentRef, left, right]);

  if (!isSplit || !left || !right || !currentRef) {
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
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
        <div
          className="relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden border-r border-border/80"
          data-split-chat-pane="left"
          data-testid="split-chat-left"
        >
          <ChatView key={scopedThreadKey(left)} {...paneProps(props, left, "left")} />
        </div>
        <div
          className="relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden"
          data-split-chat-pane="right"
          data-testid="split-chat-right"
        >
          <ChatView key={scopedThreadKey(right)} {...paneProps(props, right, "right")} />
        </div>
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
