import type { EnvironmentId, TeamMessage } from "@sparky/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { ChevronLeftIcon, LoaderIcon } from "../Hugeicons";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { teamsEnvironment } from "../../state/teams";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { TeamComposer } from "./TeamComposer";
import { TeamMessageList, teamThreadKey } from "./TeamMessageList";
import { teamsFailureMessage } from "./teamsErrors";
import { TEAM_CHAT_TITLE } from "./teamsLogic";

interface TeamChatPageProps {
  readonly environmentId: EnvironmentId;
  /** The project that holds the team chat thread. */
  readonly projectId: string;
  readonly onBack: () => void;
}

/**
 * The team-wide chat as a whole page. It is one fixed thread (titled TEAM_CHAT_TITLE), created the
 * first time the page opens and reused after that.
 */
export function TeamChatPage(props: TeamChatPageProps) {
  const { environmentId, projectId, onBack } = props;

  const threadsQuery = useEnvironmentQuery(
    teamsEnvironment.listThreads({ environmentId, input: { projectId } }),
  );
  const viewerQuery = useEnvironmentQuery(teamsEnvironment.listTeams({ environmentId, input: {} }));
  const viewerLogin = viewerQuery.data?.viewer ?? null;
  const createThread = useAtomCommand(teamsEnvironment.createThread, { reportFailure: false });
  const chatThread =
    threadsQuery.data?.threads.find((thread) => thread.title === TEAM_CHAT_TITLE) ?? null;
  const threadsLoaded = threadsQuery.data !== null;
  const refreshThreads = threadsQuery.refresh;

  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);

  useEffect(() => {
    if (!threadsLoaded || chatThread !== null || error !== null || creatingRef.current) {
      return;
    }
    creatingRef.current = true;
    void createThread({ environmentId, input: { projectId, body: TEAM_CHAT_TITLE } }).then(
      (result) => {
        creatingRef.current = false;
        if (AsyncResult.isSuccess(result)) {
          refreshThreads();
        } else {
          setError(teamsFailureMessage(result, "Could not open the team chat."));
        }
      },
    );
  }, [threadsLoaded, chatThread, error, environmentId, projectId, createThread, refreshThreads]);

  // A failed load shows its reason instead of spinning forever.
  const loadError = error ?? threadsQuery.error;

  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<TeamMessage | null>(null);
  const [messageRefresh, setMessageRefresh] = useState(0);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 px-4 pb-4 pt-2 sm:px-6">
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
        <h1 className="min-w-0 truncate text-base font-semibold text-foreground">Team chat</h1>
      </div>

      {chatThread !== null ? (
        <>
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <TeamMessageList
              key={teamThreadKey(projectId, chatThread.id)}
              environmentId={environmentId}
              projectId={projectId}
              threadId={chatThread.id}
              refreshToken={messageRefresh}
              onReply={setReplyTo}
              viewerLogin={viewerLogin}
            />
          </section>
          <TeamComposer
            environmentId={environmentId}
            projectId={projectId}
            threadId={chatThread.id}
            replyTo={replyTo}
            draft={draft}
            focusRequest={0}
            onDraftChange={setDraft}
            onClearReply={() => setReplyTo(null)}
            onThreadCreated={() => undefined}
            onMessagePosted={() => setMessageRefresh((count) => count + 1)}
            onOpenProjects={() => undefined}
          />
        </>
      ) : loadError !== null ? (
        <p className="py-10 text-center text-sm text-destructive">{loadError}</p>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
