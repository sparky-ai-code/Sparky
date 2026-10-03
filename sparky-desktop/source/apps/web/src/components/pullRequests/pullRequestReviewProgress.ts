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
  readonly activeKey: string | null;
  readonly progressByKey: ReadonlyMap<string, PullRequestReviewProgress>;
};

export type PullRequestReviewProgressReporter = (
  phase: PullRequestReviewProgressPhase,
  message: string,
) => void;

const MAX_PROGRESS_ENTRIES = 80;

let snapshot: PullRequestReviewProgressSnapshot = {
  activeKey: null,
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

function publish(
  progress: PullRequestReviewProgress,
  activeKey: string | null = snapshot.activeKey,
): void {
  const progressByKey = new Map(snapshot.progressByKey);
  progressByKey.delete(progress.key);
  progressByKey.set(progress.key, progress);

  while (progressByKey.size > MAX_PROGRESS_ENTRIES) {
    const oldestKey = [...progressByKey.keys()].find((key) => key !== activeKey);
    if (oldestKey === undefined) break;
    progressByKey.delete(oldestKey);
  }

  snapshot = { activeKey, progressByKey };
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
  if (snapshot.activeKey !== null) return null;

  const report: PullRequestReviewProgressReporter = (phase, message) => {
    if (snapshot.activeKey !== key) return;
    publish({ key, phase, message }, key);
  };

  publish(
    {
      key,
      phase: "fetching",
      message: "Fetching the latest pull-request changes from GitHub…",
    },
    key,
  );

  return Promise.resolve()
    .then(() => task(report))
    .then(() => {
      const current = snapshot.progressByKey.get(key);
      if (
        snapshot.activeKey === key &&
        current?.phase !== "success" &&
        current?.phase !== "error"
      ) {
        report("success", "Review complete.");
      }
    })
    .catch((cause: unknown) => report("error", defaultErrorMessage(cause)))
    .finally(() => {
      if (snapshot.activeKey === key) {
        snapshot = { ...snapshot, activeKey: null };
        for (const listener of listeners) listener();
      }
    });
}
