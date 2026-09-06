import { EnvironmentId, UNSCOPED_CHAT_PROJECT_ID } from "@sparky/contracts";
import { scopeProjectRef } from "@sparky/client-runtime/environment";
import { createFileRoute } from "@tanstack/react-router";
import { RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";

function ChatIndexRouteView() {
  return <IndexDraftLanding />;
}

/**
 * Landing on the index route drops straight into a normal draft thread for the
 * most recently active project, or an unscoped draft when no project exists.
 */
function IndexDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const handleNewThread = useNewThreadHandler();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject = useMemo(
    () =>
      bootstrapped
        ? (sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null)
        : null,
    [bootstrapped, projects, threads],
  );
  const unscopedProjectRef = useMemo(
    () =>
      scopeProjectRef(
        primaryEnvironmentId ?? EnvironmentId.make("local"),
        UNSCOPED_CHAT_PROJECT_ID,
      ),
    [primaryEnvironmentId],
  );
  const startProjectRef = useMemo(
    () =>
      mostRecentProject === null
        ? unscopedProjectRef
        : scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id),
    [mostRecentProject, unscopedProjectRef],
  );

  useEffect(() => {
    if (!bootstrapped || startingRef.current) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(startProjectRef, {
      replace: true,
    }).catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [bootstrapped, handleNewThread, startProjectRef, startState.retryRequest]);

  if (!bootstrapped) {
    return null;
  }
  if (startState.failed) {
    return (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    );
  }
  return null;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            The chat is still available. Try opening a new draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
