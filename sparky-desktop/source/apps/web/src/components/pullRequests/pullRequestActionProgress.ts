export type PullRequestAction = "merge" | "squash" | "close";

export type PullRequestActionSnapshot = {
  readonly busyByKey: ReadonlyMap<string, PullRequestAction>;
  readonly errorByKey: ReadonlyMap<string, string>;
};

const MAX_ACTION_ERRORS = 80;

let snapshot: PullRequestActionSnapshot = {
  busyByKey: new Map(),
  errorByKey: new Map(),
};

const listeners = new Set<() => void>();

export function getPullRequestActionSnapshot(): PullRequestActionSnapshot {
  return snapshot;
}

export function subscribeToPullRequestActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: PullRequestActionSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Run actions on different PRs independently, but prevent a second mutation
 * of the same PR. The in-flight state survives a page unmount or PR switch.
 */
export function startPullRequestAction(
  key: string,
  action: PullRequestAction,
  task: () => Promise<void>,
): Promise<void> | null {
  if (snapshot.busyByKey.has(key)) return null;

  const busyByKey = new Map(snapshot.busyByKey);
  busyByKey.set(key, action);
  const errorByKey = new Map(snapshot.errorByKey);
  errorByKey.delete(key);
  publish({ busyByKey, errorByKey });

  return Promise.resolve()
    .then(task)
    .catch((cause: unknown) => {
      const error =
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : `Could not ${action} pull request.`;
      const nextErrors = new Map(snapshot.errorByKey);
      nextErrors.delete(key);
      nextErrors.set(key, error);
      while (nextErrors.size > MAX_ACTION_ERRORS) {
        const oldest = nextErrors.keys().next().value;
        if (oldest === undefined) break;
        nextErrors.delete(oldest);
      }
      publish({ ...snapshot, errorByKey: nextErrors });
    })
    .finally(() => {
      const remaining = new Map(snapshot.busyByKey);
      remaining.delete(key);
      publish({ ...snapshot, busyByKey: remaining });
    });
}
