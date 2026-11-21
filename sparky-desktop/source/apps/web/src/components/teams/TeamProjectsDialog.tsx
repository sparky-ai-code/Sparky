import type { EnvironmentId, Team } from "@sparky/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState, type FormEvent } from "react";

import { teamsEnvironment } from "../../state/teams";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { teamsFailureMessage } from "./teamsErrors";

interface TeamProjectsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly team: Team;
  /** Called after a project is added, so the team refreshes. */
  readonly onChanged: () => void;
}

export function TeamProjectsDialog(props: TeamProjectsDialogProps) {
  const { open, onOpenChange, environmentId, team, onChanged } = props;
  const addProject = useAtomCommand(teamsEnvironment.addProject, { reportFailure: false });

  const [nameWithOwner, setNameWithOwner] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Projects</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {team.projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No projects yet.</p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {team.projects.map((project) => (
                <li
                  key={project.id}
                  title={project.localPath ?? undefined}
                  className="min-w-0 px-3 py-2"
                >
                  <a
                    href={project.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block truncate text-sm font-medium text-foreground hover:underline"
                  >
                    {project.nameWithOwner}
                  </a>
                </li>
              ))}
            </ul>
          )}

          <form
            onSubmit={(event) => void handleAddProject(event)}
            className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
          >
            <Input
              value={nameWithOwner}
              onChange={(event) => setNameWithOwner(event.target.value)}
              placeholder="owner/name"
              aria-label="GitHub repository"
              autoComplete="off"
              disabled={busy}
            />
            <Input
              value={localPath}
              onChange={(event) => setLocalPath(event.target.value)}
              placeholder="Local folder (optional)"
              aria-label="Local folder"
              autoComplete="off"
              disabled={busy}
            />
            <Button type="submit" disabled={busy || nameWithOwner.trim().length === 0}>
              {busy ? "Adding…" : "Add"}
            </Button>
            {error !== null ? (
              <p className="text-xs text-destructive sm:col-span-3">{error}</p>
            ) : null}
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
