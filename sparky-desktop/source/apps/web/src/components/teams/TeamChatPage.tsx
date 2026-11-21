import type { EnvironmentId, TeamMessage, TeamThread } from "@sparky/contracts";
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

const TEAM_CHAT_LOAD_STALL_MS = 15_000;

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
  // The thread this page created itself. GitHub's label listing can lag a few seconds behind a
  // new issue, so the created thread is used directly until the listing catches up.
  const [createdThread, setCreatedThread] = useState<TeamThread | null>(null);
  const chatThread =
    threadsQuery.data?.threads.find((thread) => thread.title === TEAM_CHAT_TITLE) ?? createdThread;
  const threadsLoaded = threadsQuery.data !== null;
  const refreshThreads = threadsQuery.refresh;

  const [createFailure, setCreateFailure] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  // Creating the thread happens once per open. A failed attempt may be retried by reopening.
  const createStartedRef = useRef(false);

  useEffect(() => {
    if (!threadsLoaded || chatThread !== null || createStartedRef.current) {
      return;
    }
    createStartedRef.current = true;
    void createThread({ environmentId, input: { projectId, body: TEAM_CHAT_TITLE } }).then(
      (result) => {
        if (AsyncResult.isSuccess(result)) {
          setCreatedThread(result.value);
          refreshThreads();
        } else {
          createStartedRef.current = false;
          setCreateFailure(teamsFailureMessage(result, "Could not open the team chat."));
        }
      },
    );
  }, [threadsLoaded, chatThread, environmentId, projectId, createThread, refreshThreads]);

  // Without this the page would spin forever when a GitHub request never settles.
  useEffect(() => {
    if (chatThread !== null) {
      setStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), TEAM_CHAT_LOAD_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [chatThread]);

  const loadError =
    createFailure ??
    threadsQuery.error ??
    (stalled
      ? "The team chat is taking too long to open. Check that the GitHub CLI is signed in (gh auth status), then go back and open it again."
      : null);

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
