import type { EnvironmentId, Team, TeamsInviteMemberResult } from "@sparky/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState, type FormEvent } from "react";

import { teamsEnvironment } from "../../state/teams";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { teamsFailureMessage } from "./teamsErrors";

type InviteGrant = TeamsInviteMemberResult["grants"][number];

const GRANT_LABELS: Record<InviteGrant["status"], string> = {
  invited: "Access granted",
  "already-member": "Already a collaborator",
  failed: "Failed",
};

interface InviteMemberDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly team: Team;
  /** Called after an invite so the team list can refresh its members and projects. */
  readonly onInvited: () => void;
}

export function InviteMemberDialog(props: InviteMemberDialogProps) {
  const { open, onOpenChange, environmentId, team, onInvited } = props;
  const inviteMember = useAtomCommand(teamsEnvironment.inviteMember, { reportFailure: false });

  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grants, setGrants] = useState<readonly InviteGrant[] | null>(null);

  useEffect(() => {
    if (!open) {
      setLogin("");
      setError(null);
      setGrants(null);
    }
  }, [open]);

  const trimmedLogin = login.trim();
  const canInvite = trimmedLogin.length > 0 && !busy;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canInvite) {
      return;
    }
    setBusy(true);
    setError(null);
    setGrants(null);
    try {
      const result = await inviteMember({
        environmentId,
        input: { teamId: team.id, login: trimmedLogin },
      });
      if (AsyncResult.isSuccess(result)) {
        setGrants(result.value.grants);
        setLogin("");
        onInvited();
      } else {
        setError(teamsFailureMessage(result, "Could not invite that GitHub account."));
      }
    } finally {
      setBusy(false);
    }
  };

  const projectName = (projectId: string) =>
    team.projects.find((project) => project.id === projectId)?.nameWithOwner ?? projectId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Invite</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogPanel className="space-y-3">
            {team.members.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {team.members.map((member) => (
                  <li
                    key={member}
                    className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {member}
                  </li>
                ))}
              </ul>
            ) : null}
            <Input
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              placeholder="GitHub login"
              aria-label="GitHub login"
              autoComplete="off"
              autoFocus
              disabled={busy}
            />
            {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
            {grants !== null ? (
              <ul className="space-y-1.5 text-xs">
                {grants.length === 0 ? (
                  <li className="text-muted-foreground">No projects in this team yet.</li>
                ) : null}
                {grants.map((grant) => (
                  <li
                    key={grant.projectId}
                    className="flex min-w-0 flex-col rounded-md border border-border px-2.5 py-1.5"
                  >
                    <span className="truncate font-medium text-foreground">
                      {projectName(grant.projectId)}
                    </span>
                    <span
                      className={
                        grant.status === "failed" ? "text-destructive" : "text-muted-foreground"
                      }
                    >
                      {GRANT_LABELS[grant.status]}
                      {grant.detail !== undefined ? ` · ${grant.detail}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="submit" disabled={!canInvite}>
              {busy ? "Inviting…" : "Invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
