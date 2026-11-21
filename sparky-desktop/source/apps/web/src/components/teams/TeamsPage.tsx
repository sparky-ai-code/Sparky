import type { EnvironmentId, Team } from "@sparky/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";
import { useTeamAgentDraft, useTeamAgentProjectRef } from "../../hooks/useTeamAgentDraft";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import ChatView from "../ChatView";
import {
  ChevronLeftIcon,
  FolderPlusIcon,
  LoaderIcon,
  MessageCircleIcon,
  UserPlusIcon,
} from "../Hugeicons";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { teamsEnvironment } from "../../state/teams";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarMenu } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InviteMemberDialog } from "./InviteMemberDialog";
import { TeamChatPage } from "./TeamChatPage";
import { TeamProjectsDialog } from "./TeamProjectsDialog";
import { TeamSuggestedPrompts } from "./TeamSuggestedPrompts";
import { TeamProjectPage } from "./TeamProjectPage";
import { TeamProjectRow } from "./TeamProjectRow";
import { TeamsTitlebarActions } from "./TeamsTitlebarActions";
import { TeamSidebarRow, TeamSidebarRowList } from "./TeamSidebarRow";
import { teamsFailureMessage } from "./teamsErrors";
import {
  pickDefaultTeam,
  pickSuggestedPrompts,
  SUGGESTED_PROMPT_COUNT,
  TEAM_PROMPT_POOL,
  teamsViewMode,
} from "./teamsLogic";

const TEAMS_LOAD_STALL_MS = 10_000;
const EMPTY_TEAMS: readonly Team[] = [];

export function TeamsPage() {
  const environmentId = usePrimaryEnvironmentId();
  const teamsQuery = useEnvironmentQuery(
    environmentId !== null ? teamsEnvironment.listTeams({ environmentId, input: {} }) : null,
  );
  const createTeam = useAtomCommand(teamsEnvironment.createTeam, { reportFailure: false });
  const [openTeamId, setOpenTeamId] = useState<string | null>(null);
  const [teamsLoadStalled, setTeamsLoadStalled] = useState(false);

  const teamsData = teamsQuery.data;

  // A query that never settles would otherwise spin forever. After a while, say what to check.
  useEffect(() => {
    if (teamsData !== null) {
      setTeamsLoadStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setTeamsLoadStalled(true), TEAMS_LOAD_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [teamsData]);

  const teams = teamsData?.teams ?? EMPTY_TEAMS;
  const refreshTeams = teamsQuery.refresh;
  const mode = teamsViewMode(teams.length);
  const activeTeam: Team | null =
    mode === "list"
      ? (teams.find((team) => team.id === openTeamId) ?? null)
      : pickDefaultTeam(teams);

  const handleCreateTeam = async (name: string): Promise<string | null> => {
    if (environmentId === null) {
      return "No environment is available.";
    }
    const result = await createTeam({ environmentId, input: { name } });
    if (AsyncResult.isSuccess(result)) {
      setOpenTeamId(result.value.id);
      refreshTeams();
      return null;
    }
    return teamsFailureMessage(result, "Could not create the team.");
  };

  let body: ReactNode;
  if (environmentId === null) {
    body = <p className="p-6 text-sm text-muted-foreground">No environment is available.</p>;
  } else if (teamsData === null && teamsQuery.isPending) {
    body = teamsLoadStalled ? (
      <p className="p-6 text-sm text-muted-foreground">
        Teams isn't responding. Check <code>gh auth status</code>, then reload.
      </p>
    ) : (
      <div className="flex flex-1 items-center justify-center py-20">
        <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (teamsData === null && teamsQuery.error !== null) {
    body = <p className="p-6 text-sm text-destructive">{teamsQuery.error}</p>;
  } else if (mode === "empty") {
    body = (
      <div className="flex flex-1 items-center justify-center p-4">
        <CreateTeamCard title="Create a team" onCreate={handleCreateTeam} />
      </div>
    );
  } else if (activeTeam === null) {
    body = (
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
        <div className="grid gap-2 sm:grid-cols-2">
          {teams.map((team) => (
            <button
              key={team.id}
              type="button"
              onClick={() => setOpenTeamId(team.id)}
              className="min-w-0 truncate rounded-lg border border-border bg-card px-4 py-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {team.name}
            </button>
          ))}
        </div>
        <CreateTeamCard title="New team" onCreate={handleCreateTeam} compact />
      </div>
    );
  } else {
    body = (
      <TeamWorkspace
        key={activeTeam.id}
        environmentId={environmentId}
        team={activeTeam}
        teams={teams}
        showBack={mode === "list"}
        onBack={() => setOpenTeamId(null)}
        onSwitchTeam={setOpenTeamId}
        onTeamsChanged={refreshTeams}
      />
    );
  }

  return (
    // Content starts below the window title bar so its buttons never sit under the
    // Windows minimize / maximize / close controls.
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto pt-[var(--workspace-topbar-height)]">
      {activeTeam === null ? (
        <header className="px-4 pb-3 pt-2 sm:px-6">
          <h1 className="text-base font-semibold text-foreground">Teams</h1>
        </header>
      ) : null}
      {body}
    </div>
  );
}

interface CreateTeamCardProps {
  readonly title: string;
  readonly compact?: boolean;
  readonly onCreate: (name: string) => Promise<string | null>;
}

function CreateTeamCard(props: CreateTeamCardProps) {
  const { title, compact = false, onCreate } = props;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onCreate(trimmed);
    setBusy(false);
    if (failure === null) {
      setName("");
    } else {
      setError(failure);
    }
  };

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className={cn(
        "flex w-full flex-col gap-3 rounded-lg border border-border bg-card p-5",
        compact ? "max-w-none" : "max-w-sm",
      )}
    >
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Team name"
          aria-label="Team name"
          autoComplete="off"
          disabled={busy}
          className="min-w-0 flex-1"
        />
        <Button type="submit" disabled={busy || name.trim().length === 0}>
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
      {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}

interface TeamWorkspaceProps {
  readonly environmentId: EnvironmentId;
  readonly team: Team;
  readonly teams: readonly Team[];
  readonly showBack: boolean;
  readonly onBack: () => void;
  readonly onSwitchTeam: (teamId: string) => void;
  readonly onTeamsChanged: () => void;
}

/** One open team: top row, Sparky's composer, suggested prompts, then projects with their threads. */
function TeamWorkspace(props: TeamWorkspaceProps) {
  const { environmentId, team, teams, showBack, onBack, onSwitchTeam, onTeamsChanged } = props;

  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const projectId =
    team.projects.find((project) => project.id === projectChoice)?.id ??
    team.projects[0]?.id ??
    null;
  const selectedProject = team.projects.find((project) => project.id === projectId) ?? null;

  const [projectsOpen, setProjectsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // The project whose page (its threads) is open. Null shows the list of projects.
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const openProject = team.projects.find((project) => project.id === openProjectId) ?? null;
  // The team chat lives in the first project, so it never moves when the selection changes.
  const chatProjectId = team.projects[0]?.id ?? null;

  // Sparky's composer runs on a draft for the selected project's chat.
  const agentProjectRef = useTeamAgentProjectRef(selectedProject?.localPath ?? null);
  const ensureDraft = useTeamAgentDraft();
  const [draftId, setDraftId] = useState<DraftId | null>(null);
  // Text typed before switching projects, carried into the next project's draft.
  const carriedPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (draftId !== null || agentProjectRef === null) {
      return;
    }
    const nextDraftId = ensureDraft(agentProjectRef);
    const carried = carriedPromptRef.current;
    if (carried !== null) {
      useComposerDraftStore.getState().setPrompt(nextDraftId, carried);
      carriedPromptRef.current = null;
    }
    setDraftId(nextDraftId);
  }, [agentProjectRef, draftId, ensureDraft]);
  // Team projects the @ menu can tag. Tagging one moves the composer to that project's chat.
  const teamMentions = useMemo(
    () =>
      team.projects.map((project) => ({
        id: project.id,
        label: project.nameWithOwner,
        description: project.localPath ?? "",
      })),
    [team.projects],
  );
  const draftSession = useComposerDraftStore((store) =>
    draftId !== null ? store.getDraftSession(draftId) : null,
  );
  const draftPrompt = useComposerDraftStore((store) =>
    draftId !== null ? (store.getComposerDraft(draftId)?.prompt ?? "") : "",
  );
  // Suggested prompts are picked once per mount, so reopening the page shows a different set.
  const [suggestedPrompts] = useState(() =>
    pickSuggestedPrompts(TEAM_PROMPT_POOL, SUGGESTED_PROMPT_COUNT),
  );

  const selectProject = (nextProjectId: string) => {
    if (draftId !== null) {
      const store = useComposerDraftStore.getState();
      carriedPromptRef.current = store.getComposerDraft(draftId)?.prompt ?? "";
      store.setPrompt(draftId, "");
    }
    setProjectChoice(nextProjectId);
    setDraftId(null);
  };

  const openProjectPage = (projectIdToOpen: string) => {
    setOpenProjectId(projectIdToOpen);
    selectProject(projectIdToOpen);
  };

  // A suggested prompt is sent to the selected project, so it starts with that project's tag.
  const pickPrompt = (prompt: string) => {
    if (draftId !== null) {
      const tag = selectedProject !== null ? `@${selectedProject.nameWithOwner} ` : "";
      useComposerDraftStore.getState().setPrompt(draftId, `${tag}${prompt}`);
    }
  };

  if (chatOpen && chatProjectId !== null) {
    return (
      <TeamChatPage
        environmentId={environmentId}
        projectId={chatProjectId}
        onBack={() => setChatOpen(false)}
      />
    );
  }

  if (openProject !== null) {
    return <TeamProjectPage project={openProject} onBack={() => setOpenProjectId(null)} />;
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4 px-4 pb-6 pt-2 sm:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {showBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to teams"
            onClick={onBack}
          >
            <ChevronLeftIcon />
          </Button>
        ) : null}
        {teams.length > 1 && !showBack ? (
          <div className="w-48 max-w-full">
            <Select
              value={team.id}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  onSwitchTeam(value);
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Switch team" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent matchTriggerWidth>
                {teams.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <h1 className="min-w-0 truncate text-base font-semibold text-foreground">{team.name}</h1>
        )}
        <TeamsTitlebarActions>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Team chat"
                  disabled={chatProjectId === null}
                  className="inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  onClick={() => setChatOpen(true)}
                />
              }
            >
              <MessageCircleIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Team chat</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Add team members"
                  className="inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => setInviteOpen(true)}
                />
              }
            >
              <UserPlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Add team members</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Add project"
                  className="inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => setProjectsOpen(true)}
                />
              }
            >
              <FolderPlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Add project</TooltipPopup>
          </Tooltip>{" "}
        </TeamsTitlebarActions>
      </div>

      <div className="relative flex h-[260px] min-h-0 flex-col [&_.chat-composer-glass]:shadow-none">
        {draftId !== null && draftSession !== null ? (
          <ChatView
            key={draftId}
            composerOnly
            teamProjectMentions={teamMentions}
            onSelectTeamProject={selectProject}
            routeKind="draft"
            draftId={draftId}
            environmentId={draftSession.environmentId}
            threadId={draftSession.threadId}
            forceExpandedMobileComposer
          />
        ) : null}
      </div>

      {draftPrompt.trim().length === 0 ? (
        <TeamSuggestedPrompts prompts={suggestedPrompts} onPick={pickPrompt} />
      ) : null}

      <SidebarMenu>
        {team.projects.map((project) => (
          <TeamProjectRow
            key={project.id}
            name={project.nameWithOwner}
            localPath={project.localPath}
            onSelect={() => openProjectPage(project.id)}
          />
        ))}
      </SidebarMenu>

      <TeamProjectsDialog
        open={projectsOpen}
        onOpenChange={setProjectsOpen}
        environmentId={environmentId}
        team={team}
        onChanged={onTeamsChanged}
      />
      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        environmentId={environmentId}
        team={team}
        onInvited={onTeamsChanged}
      />
    </div>
  );
}
