import type { EnvironmentId, Team, TeamMessage, TeamThread } from "@sparky/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { ArrowLeftIcon, FolderIcon, LoaderCircleIcon, UserPlusIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { teamsEnvironment } from "../../state/teams";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { InviteMemberDialog } from "./InviteMemberDialog";
import { TeamComposer } from "./TeamComposer";
import { TeamMessageList, teamThreadKey } from "./TeamMessageList";
import { TeamProjectsDialog } from "./TeamProjectsDialog";
import { TeamThreadList } from "./TeamThreadList";
import { teamsFailureMessage } from "./teamsErrors";
import { mergeById, pickDefaultTeam, SUGGESTED_TEAM_PROMPTS, teamsViewMode } from "./teamsLogic";
import { useTeamPolling } from "./useTeamPolling";

const THREAD_POLL_INTERVAL_MS = 15_000;
const TEAMS_LOAD_STALL_MS = 10_000;
const EMPTY_TEAMS: readonly Team[] = [];
const EMPTY_THREADS: readonly TeamThread[] = [];

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
  const viewerLogin = teamsData?.viewer ?? null;
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
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
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
        viewerLogin={viewerLogin}
        showBack={mode === "list"}
        onBack={() => setOpenTeamId(null)}
        onSwitchTeam={setOpenTeamId}
        onTeamsChanged={refreshTeams}
      />
    );
  }

  // The workspace draws its own top bar. Other states get a plain title.
  const showTitleBar = activeTeam === null;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto">
      {showTitleBar ? (
        <header className="flex items-center gap-2 border-b border-border px-4 py-3 sm:px-6">
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
  readonly viewerLogin: string | null;
  readonly showBack: boolean;
  readonly onBack: () => void;
  readonly onSwitchTeam: (teamId: string) => void;
  readonly onTeamsChanged: () => void;
}

/** One open team: top bar, composer, prompts, then threads beside messages. */
function TeamWorkspace(props: TeamWorkspaceProps) {
  const {
    environmentId,
    team,
    teams,
    viewerLogin,
    showBack,
    onBack,
    onSwitchTeam,
    onTeamsChanged,
  } = props;

  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const projectId =
    team.projects.find((project) => project.id === projectChoice)?.id ??
    team.projects[0]?.id ??
    null;

  const [projectsOpen, setProjectsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const [threadId, setThreadId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<TeamMessage | null>(null);
  const [draft, setDraft] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const [messageRefresh, setMessageRefresh] = useState(0);

  const threadsQuery = useEnvironmentQuery(
    projectId !== null
      ? teamsEnvironment.listThreads({ environmentId, input: { projectId } })
      : null,
  );
  const threadsData = threadsQuery.data;
  const refreshThreads = threadsQuery.refresh;

  // Thread list is merged by id, so a poll that changes nothing keeps the same array.
  const [threadState, setThreadState] = useState<{
    readonly projectId: string | null;
    readonly items: readonly TeamThread[];
  }>({ projectId: null, items: EMPTY_THREADS });

  useEffect(() => {
    if (threadsData === null || projectId === null) {
      return;
    }
    const incoming = threadsData.threads;
    setThreadState((previous) => {
      const base = previous.projectId === projectId ? previous.items : EMPTY_THREADS;
      const items = mergeById(base, incoming);
      return previous.projectId === projectId && items === previous.items
        ? previous
        : { projectId, items };
    });
  }, [threadsData, projectId]);

  useTeamPolling({
    enabled: projectId !== null,
    intervalMs: THREAD_POLL_INTERVAL_MS,
    run: refreshThreads,
  });

  const threads = threadState.projectId === projectId ? threadState.items : EMPTY_THREADS;
  const threadsLoading = threadsData === null && threadsQuery.isPending;
  const threadsError = threadsData === null ? threadsQuery.error : null;

  const selectProject = (nextProjectId: string) => {
    setProjectChoice(nextProjectId);
    setThreadId(null);
    setReplyTo(null);
  };

  const selectThread = (nextThreadId: string) => {
    setThreadId(nextThreadId);
    setReplyTo(null);
  };

  const handleThreadCreated = (thread: TeamThread) => {
    setThreadState((previous) => ({
      projectId,
      items: [
        thread,
        ...(previous.projectId === projectId ? previous.items : []).filter(
          (entry) => entry.id !== thread.id,
        ),
      ],
    }));
    setThreadId(thread.id);
    setReplyTo(null);
    refreshThreads();
    onTeamsChanged();
  };

  const handleMessagePosted = () => {
    setMessageRefresh((count) => count + 1);
    refreshThreads();
  };

  const handleReply = (message: TeamMessage) => {
    setReplyTo(message);
    setFocusRequest((count) => count + 1);
  };

  const pickPrompt = (prompt: string) => {
    setDraft(prompt);
    setFocusRequest((count) => count + 1);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        {showBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to teams"
            onClick={onBack}
          >
            <ArrowLeftIcon />
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
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setProjectsOpen(true)}>
            <FolderIcon />
            Projects
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlusIcon />
            Invite
          </Button>
        </div>
      </div>

      <TeamComposer
        environmentId={environmentId}
        projectId={projectId}
        threadId={threadId}
        replyTo={replyTo}
        draft={draft}
        focusRequest={focusRequest}
        onDraftChange={setDraft}
        onClearReply={() => setReplyTo(null)}
        onThreadCreated={handleThreadCreated}
        onMessagePosted={handleMessagePosted}
        onOpenProjects={() => setProjectsOpen(true)}
      />

      {projectId !== null ? (
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTED_TEAM_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => pickPrompt(prompt)}
              className="max-w-full rounded-full border border-border px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {prompt}
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(220px,300px)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-lg border border-border bg-card">
          <TeamThreadList
            projects={team.projects}
            projectId={projectId}
            onSelectProject={selectProject}
            threads={threads}
            loading={threadsLoading}
            error={threadsError}
            selectedThreadId={threadId}
            onSelectThread={selectThread}
            viewerLogin={viewerLogin}
          />
        </section>

        <section className="flex h-[60vh] min-h-72 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card lg:h-[520px]">
          {projectId !== null && threadId !== null ? (
            <TeamMessageList
              key={teamThreadKey(projectId, threadId)}
              environmentId={environmentId}
              projectId={projectId}
              threadId={threadId}
              refreshToken={messageRefresh}
              onReply={handleReply}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
              {projectId === null ? "No project yet." : "Select a thread."}
            </div>
          )}
        </section>
      </div>

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
