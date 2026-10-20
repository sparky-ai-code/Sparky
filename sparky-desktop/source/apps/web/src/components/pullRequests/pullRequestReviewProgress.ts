export type PullRequestReviewProgressPhase =
  | "fetching"
  | "reviewing"
  | "validating"
  | "posting"
  | "success"
  | "error";

export type PullRequestReviewProgress = {
  readonly key: string;
  readonly phase: PullRequestReviewProgressPhase;
  readonly message: string;
};

export type PullRequestReviewProgressSnapshot = {
  readonly activeKeys: ReadonlySet<string>;
  readonly progressByKey: ReadonlyMap<string, PullRequestReviewProgress>;
};

export type PullRequestReviewProgressReporter = (
  phase: PullRequestReviewProgressPhase,
  message: string,
) => void;

const MAX_PROGRESS_ENTRIES = 80;

let snapshot: PullRequestReviewProgressSnapshot = {
  activeKeys: new Set(),
  progressByKey: new Map(),
};

const listeners = new Set<() => void>();

export function getPullRequestReviewProgressSnapshot(): PullRequestReviewProgressSnapshot {
  return snapshot;
}

export function subscribeToPullRequestReviewProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(progress: PullRequestReviewProgress): void {
  const progressByKey = new Map(snapshot.progressByKey);
  progressByKey.delete(progress.key);
  progressByKey.set(progress.key, progress);

  while (progressByKey.size > MAX_PROGRESS_ENTRIES) {
    const oldestKey = [...progressByKey.keys()].find((key) => !snapshot.activeKeys.has(key));
    if (oldestKey === undefined) break;
    progressByKey.delete(oldestKey);
  }

  snapshot = { ...snapshot, progressByKey };
  for (const listener of listeners) listener();
}

function defaultErrorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "Could not review this pull request.";
}

/** Starts one app-lifetime review task and keeps its progress independent of page mounting. */
export function startPullRequestReviewProgress(
  key: string,
  task: (report: PullRequestReviewProgressReporter) => Promise<void>,
): Promise<void> | null {
  if (snapshot.activeKeys.has(key)) return null;

  snapshot = { ...snapshot, activeKeys: new Set(snapshot.activeKeys).add(key) };
  for (const listener of listeners) listener();

  const report: PullRequestReviewProgressReporter = (phase, message) => {
    if (!snapshot.activeKeys.has(key)) return;
    publish({ key, phase, message });
  };

  publish({
    key,
    phase: "fetching",
    message: "Fetching the latest pull-request changes from GitHub…",
  });

  return Promise.resolve()
    .then(() => task(report))
    .then(() => {
      const current = snapshot.progressByKey.get(key);
      if (
        snapshot.activeKeys.has(key) &&
        current?.phase !== "success" &&
        current?.phase !== "error"
      ) {
        report("success", "Review complete.");
      }
    })
    .catch((cause: unknown) => report("error", defaultErrorMessage(cause)))
    .finally(() => {
      if (snapshot.activeKeys.has(key)) {
        const activeKeys = new Set(snapshot.activeKeys);
        activeKeys.delete(key);
        snapshot = { ...snapshot, activeKeys };
        for (const listener of listeners) listener();
      }
    });
}
