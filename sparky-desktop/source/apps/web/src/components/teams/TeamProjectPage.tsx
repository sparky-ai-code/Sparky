import type { TeamProject } from "@sparky/contracts";
import { scopeThreadRef } from "@sparky/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { useTeamAgentProjectRef } from "../../hooks/useTeamAgentDraft";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { ChevronLeftIcon } from "../Hugeicons";
import { Button } from "../ui/button";
import { TeamSidebarRowList } from "./TeamSidebarRow";
import { TeamThreadList } from "./TeamThreadList";

interface TeamProjectPageProps {
  readonly project: TeamProject;
  readonly onBack: () => void;
}

/**
 * A whole page for one project: its Sparky threads, as rows. Empty when the project has none.
 * Clicking a thread opens Sparky's normal thread view.
 */
export function TeamProjectPage(props: TeamProjectPageProps) {
  const { project, onBack } = props;
  const navigate = useNavigate();

  // The project's threads are Sparky's own threads for its folder. Only a linked folder has them.
  const agentProjectRef = useTeamAgentProjectRef(project.localPath);
  const threadScope = useMemo(
    () => (agentProjectRef !== null && project.localPath ? [agentProjectRef] : []),
    // The ref is rebuilt each render, so key the memo on its values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentProjectRef?.environmentId, agentProjectRef?.projectId, project.localPath],
  );
  const shells = useThreadShellsForProjectRefs(threadScope);
  const threads = useMemo(
    () =>
      shells
        .filter((shell) => shell.archivedAt === null)
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [shells],
  );

  const openThread = (shell: (typeof threads)[number]) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(shell.environmentId, shell.id)),
    });
  };

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3 px-4 pb-6 pt-2 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back to team"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </Button>
        <h1 className="min-w-0 truncate text-base font-semibold text-foreground">
          {project.nameWithOwner}
        </h1>
      </div>
      {threads.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">No threads</p>
      ) : (
        <TeamSidebarRowList>
          <TeamThreadList threads={threads} onOpen={openThread} />
        </TeamSidebarRowList>
      )}
    </div>
  );
}
