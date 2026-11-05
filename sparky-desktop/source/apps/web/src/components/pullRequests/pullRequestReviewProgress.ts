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
  readonly reviewSummary?: string;
};

export type PullRequestReviewProgressSnapshot = {
  readonly activeKey: string | null;
  readonly activeKeys: ReadonlySet<string>;
  readonly progressByKey: ReadonlyMap<string, PullRequestReviewProgress>;
};

export type PullRequestReviewProgressReporter = (
  phase: PullRequestReviewProgressPhase,
  message: string,
  reviewSummary?: string,
) => void;

const MAX_PROGRESS_ENTRIES = 80;

let snapshot: PullRequestReviewProgressSnapshot = {
  activeKey: null,
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

function publish(
  progress: PullRequestReviewProgress,
  activeKeys: ReadonlySet<string> = snapshot.activeKeys,
): void {
  const progressByKey = new Map(snapshot.progressByKey);
  progressByKey.delete(progress.key);
  progressByKey.set(progress.key, progress);

  while (progressByKey.size > MAX_PROGRESS_ENTRIES) {
    const oldestKey = [...progressByKey.keys()].find((key) => !activeKeys.has(key));
    if (oldestKey === undefined) break;
    progressByKey.delete(oldestKey);
  }

  snapshot = { activeKey: activeKeys.values().next().value ?? null, activeKeys, progressByKey };
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
  const activeKeys = new Set(snapshot.activeKeys);
  activeKeys.add(key);

  const report: PullRequestReviewProgressReporter = (phase, message, reviewSummary) => {
    if (!snapshot.activeKeys.has(key)) return;
    const current = snapshot.progressByKey.get(key);
    const summary = reviewSummary ?? current?.reviewSummary;
    publish(
      {
        key,
        phase,
        message,
        ...(summary ? { reviewSummary: summary } : {}),
      },
    );
  };

  publish(
    {
      key,
      phase: "fetching",
      message: "Fetching the latest pull-request changes from GitHub…",
    },
    activeKeys,
  );

  return Promise.resolve()
    .then(() => task(report))
    .then(() => {
      const current = snapshot.progressByKey.get(key);
      if (snapshot.activeKeys.has(key) && current?.phase !== "success" && current?.phase !== "error") {
        report("success", "Review complete.");
      }
    })
    .catch((cause: unknown) => report("error", defaultErrorMessage(cause)))
    .finally(() => {
      const remaining = new Set(snapshot.activeKeys);
      if (remaining.delete(key)) {
        snapshot = { ...snapshot, activeKey: remaining.values().next().value ?? null, activeKeys: remaining };
        for (const listener of listeners) listener();
      }
    });
}
