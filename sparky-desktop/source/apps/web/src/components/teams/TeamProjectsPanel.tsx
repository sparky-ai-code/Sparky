import type { EnvironmentId, Team } from "@sparky/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { UserPlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { teamsEnvironment } from "../../state/teams";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InviteMemberDialog } from "./InviteMemberDialog";
import { teamsFailureMessage } from "./teamsErrors";

interface TeamProjectsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly team: Team;
  /** Called after a project is added or a member is invited, so the team list refreshes. */
  readonly onChanged: () => void;
}

export function TeamProjectsPanel(props: TeamProjectsPanelProps) {
  const { environmentId, team, onChanged } = props;
  const addProject = useAtomCommand(teamsEnvironment.addProject, { reportFailure: false });

  const [nameWithOwner, setNameWithOwner] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const handleAddProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const repository = nameWithOwner.trim();
    if (repository.length === 0 || busy) {
      return;
    }
    const folder = localPath.trim();
    setBusy(true);
    setError(null);
    try {
      const result = await addProject({
        environmentId,
        input: {
          teamId: team.id,
          nameWithOwner: repository,
          ...(folder.length > 0 ? { localPath: folder } : {}),
        },
      });
      if (AsyncResult.isSuccess(result)) {
        setNameWithOwner("");
        setLocalPath("");
        onChanged();
      } else {
        setError(teamsFailureMessage(result, "Could not add that repository."));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Team projects</h2>
        <Button type="button" variant="outline" size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlusIcon />
          Invite GitHub account
        </Button>
      </div>

      {team.members.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Members: {team.members.join(", ")}</p>
      ) : null}

      {team.projects.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No team projects yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border/60 rounded-md border border-border/60">
          {team.projects.map((project) => (
            <li key={project.id} className="flex min-w-0 flex-col px-3 py-2">
              <a
                href={project.url}
                target="_blank"
                rel="noreferrer noopener"
                className="truncate text-sm font-medium text-foreground hover:underline"
              >
                {project.nameWithOwner}
              </a>
              {project.localPath !== null ? (
                <span className="truncate text-xs text-muted-foreground">{project.localPath}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(event) => void handleAddProject(event)}
        className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <label className="grid gap-1 text-xs text-muted-foreground">
          GitHub repository
          <Input
            value={nameWithOwner}
            onChange={(event) => setNameWithOwner(event.target.value)}
            placeholder="owner/name"
            aria-label="GitHub repository"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Local folder (optional)
          <Input
            value={localPath}
            onChange={(event) => setLocalPath(event.target.value)}
            placeholder="C:\path\to\repo"
            aria-label="Local folder"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <Button type="submit" disabled={busy || nameWithOwner.trim().length === 0}>
          {busy ? "Adding…" : "Add project"}
        </Button>
      </form>
      {error !== null ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        environmentId={environmentId}
        team={team}
        onInvited={onChanged}
      />
    </section>
  );
}
