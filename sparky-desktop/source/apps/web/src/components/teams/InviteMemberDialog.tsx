import type { EnvironmentId, Team, TeamsInviteMemberResult } from "@sparky/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { UserPlusIcon } from "../Hugeicons";
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
import { stackedThreadToast, toastManager } from "../ui/toast";
import { teamsFailureMessage } from "./teamsErrors";

type InviteGrant = TeamsInviteMemberResult["grants"][number];

/** One line that says what the invite did, for the toast. */
function summarizeGrants(login: string, grants: readonly InviteGrant[]): string {
  const invited = grants.filter((grant) => grant.status === "invited").length;
  const existing = grants.filter((grant) => grant.status === "already-member").length;
  const failed = grants.filter((grant) => grant.status === "failed").length;
  const parts: string[] = [];
  if (invited > 0) parts.push(`invited to ${invited} project${invited === 1 ? "" : "s"}`);
  if (existing > 0) parts.push(`already on ${existing}`);
  if (failed > 0) parts.push(`failed on ${failed}`);
  if (parts.length === 0) return `${login} has no projects to join yet.`;
  return `${login}: ${parts.join(", ")}.`;
}

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

  useEffect(() => {
    if (!open) {
      setLogin("");
      setError(null);
    }
  }, [open]);

  const trimmedLogin = login.trim();
  const canInvite = trimmedLogin.length > 0 && !busy;

  const handleInvite = async () => {
    if (!canInvite) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await inviteMember({
        environmentId,
        input: { teamId: team.id, login: trimmedLogin },
      });
      if (AsyncResult.isSuccess(result)) {
        const allFailed =
          result.value.grants.length > 0 &&
          result.value.grants.every((grant) => grant.status === "failed");
        toastManager.add(
          stackedThreadToast({
            type: allFailed ? "error" : "success",
            title: allFailed ? "Invite failed" : "Team member invited",
            description: summarizeGrants(trimmedLogin, result.value.grants),
            data: {
              hideCopyButton: true,
              leadingIcon: <UserPlusIcon aria-hidden="true" className="size-4 text-success" />,
            },
          }),
        );
        setLogin("");
        onInvited();
        onOpenChange(false);
      } else {
        setError(teamsFailureMessage(result, "Could not invite that GitHub account."));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add team members</DialogTitle>
        </DialogHeader>
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
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleInvite();
            }}
          >
            <Input
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              placeholder="GitHub login"
              aria-label="GitHub login"
              autoComplete="off"
              autoFocus
              disabled={busy}
            />
          </form>
          {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" disabled={!canInvite} onClick={() => void handleInvite()}>
            {busy ? "Inviting…" : "Invite"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
