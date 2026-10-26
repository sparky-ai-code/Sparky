"use client";

import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@sparky/client-runtime/environment";
import { runAtomCommand } from "@sparky/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@sparky/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  applyPreviewServerEvent,
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";

class PreviewSessionThreadKeyParseError extends Schema.TaggedErrorClass<PreviewSessionThreadKeyParseError>()(
  "PreviewSessionThreadKeyParseError",
  { threadKey: Schema.String },
) {
  override get message(): string {
    return `Invalid scoped preview thread key: ${this.threadKey}`;
  }
}

const previewSessionSyncAtom = Atom.family((threadKey: string) => {
  const threadRef = parseScopedThreadKey(threadKey);
  if (threadRef === null) {
    throw new PreviewSessionThreadKeyParseError({ threadKey });
  }

  const sessionsAtom = previewEnvironment.list({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const eventsAtom = previewEnvironment.events({
    environmentId: threadRef.environmentId,
    input: {},
  });

  return Atom.make((get) => {
    let disposed = false;
    let recoveryId = 0;
    let recoveringSessionsKey: string | null = null;
    let sessionsVersion = 0;
    let eventsVersion = 0;

    const reconcileSessions = (result: Atom.Type<typeof sessionsAtom>) => {
      if (!AsyncResult.isSuccess(result)) return;
      if (recoveringSessionsKey !== null && result.value.sessions.length > 0) return;
      if (result.value.sessions.length > 0) {
        recoveringSessionsKey = null;
        recoveryId += 1;
        reconcilePreviewServerSessions(threadRef, result.value.sessions);
        return;
      }

      const previousSessions = Object.values(readThreadPreviewState(threadRef).sessions).toSorted(
        (left, right) => left.updatedAt.localeCompare(right.updatedAt),
      );
      if (previousSessions.length === 0) {
        reconcilePreviewServerSessions(threadRef, []);
        return;
      }
      const sessionUrlsKey = previousSessions
        .map((session) =>
          session.navStatus._tag === "Idle"
            ? `${session.tabId}:`
            : `${session.tabId}:${session.navStatus.url}`,
        )
        .join("|");
      if (recoveringSessionsKey === sessionUrlsKey) return;

      recoveringSessionsKey = sessionUrlsKey;
      const currentRecoveryId = ++recoveryId;
      void (async () => {
        for (const session of previousSessions) {
          if (disposed || currentRecoveryId !== recoveryId) return;
          const result = await runAtomCommand(
            get.registry,
            previewEnvironment.open,
            {
              environmentId: threadRef.environmentId,
              input: {
                threadId: threadRef.threadId,
                ...(session.navStatus._tag === "Idle" ? {} : { url: session.navStatus.url }),
              },
            },
            { reportDefect: false, reportFailure: false },
          );
          if (disposed || currentRecoveryId !== recoveryId) return;
          if (result._tag === "Success") applyPreviewServerSnapshot(threadRef, result.value);
        }
        if (disposed || currentRecoveryId !== recoveryId) return;
        recoveringSessionsKey = null;
        get.refresh(sessionsAtom);
      })();
    };

    const applyLatestEvent = (result: Atom.Type<typeof eventsAtom>) => {
      if (!AsyncResult.isSuccess(result) || result.value.threadId !== threadRef.threadId) return;
      applyPreviewServerEvent(threadRef, result.value);
      if (result.value.type === "opened" || result.value.type === "closed") {
        get.refresh(sessionsAtom);
      }
    };

    get.addFinalizer(() => {
      disposed = true;
      recoveryId += 1;
    });
    const initialSessions = get.once(sessionsAtom);
    const initialEvent = get.once(eventsAtom);
    get.subscribe(sessionsAtom, (result) => {
      sessionsVersion += 1;
      reconcileSessions(result);
    });
    get.subscribe(eventsAtom, (result) => {
      eventsVersion += 1;
      applyLatestEvent(result);
    });
    queueMicrotask(() => {
      if (disposed) return;
      if (sessionsVersion === 0) reconcileSessions(initialSessions);
      if (eventsVersion === 0) applyLatestEvent(initialEvent);
    });
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`preview:session-sync:${threadKey}`));
});

export function usePreviewSession(threadRef: ScopedThreadRef): void {
  useAtomValue(previewSessionSyncAtom(scopedThreadKey(threadRef)));
}
