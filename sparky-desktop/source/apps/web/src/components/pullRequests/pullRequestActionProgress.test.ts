import { describe, expect, it } from "vite-plus/test";

import {
  getPullRequestActionSnapshot,
  startPullRequestAction,
  subscribeToPullRequestActions,
} from "./pullRequestActionProgress.ts";

describe("pull request action progress", () => {
  it("runs different PR actions simultaneously without unlocking the same PR", async () => {
    const firstKey = `repo/actions#${Date.now()}-1`;
    const secondKey = `repo/actions#${Date.now()}-2`;
    let finishFirst: () => void = () => {};
    let finishSecond: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { finishSecond = resolve; });
    let startedFirst = false;
    let startedSecond = false;
    const first = startPullRequestAction(firstKey, "merge", async () => {
      startedFirst = true;
      await firstGate;
    });
    const second = startPullRequestAction(secondKey, "close", async () => {
      startedSecond = true;
      await secondGate;
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(getPullRequestActionSnapshot().busyByKey.get(firstKey)).toBe("merge");
    expect(getPullRequestActionSnapshot().busyByKey.get(secondKey)).toBe("close");
    expect(startPullRequestAction(firstKey, "squash", async () => {})).toBeNull();

    await Promise.resolve();
    expect(startedFirst).toBe(true);
    expect(startedSecond).toBe(true);

    finishSecond();
    await second;
    expect(getPullRequestActionSnapshot().busyByKey.has(firstKey)).toBe(true);
    expect(getPullRequestActionSnapshot().busyByKey.has(secondKey)).toBe(false);

    finishFirst();
    await first;
    expect(getPullRequestActionSnapshot().busyByKey.has(firstKey)).toBe(false);
  });

  it("retains state across subscribers and scopes failures to their own PR", async () => {
    const key = `repo/failure#${Date.now()}`;
    const otherKey = `another-repo/failure#${Date.now()}`;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let notifications = 0;
    const unsubscribe = subscribeToPullRequestActions(() => { notifications += 1; });
    const task = startPullRequestAction(key, "squash", async () => {
      await gate;
      throw new Error("GitHub rejected the squash.");
    });
    expect(getPullRequestActionSnapshot().busyByKey.get(key)).toBe("squash");
    unsubscribe();

    let returningNotifications = 0;
    const unsubscribeReturning = subscribeToPullRequestActions(() => {
      returningNotifications += 1;
    });
    expect(getPullRequestActionSnapshot().busyByKey.has(key)).toBe(true);
    const other = startPullRequestAction(otherKey, "merge", async () => {});
    await other;
    release();
    await task;
    expect(getPullRequestActionSnapshot().errorByKey.get(key)).toBe(
      "GitHub rejected the squash.",
    );
    expect(getPullRequestActionSnapshot().errorByKey.has(otherKey)).toBe(false);
    expect(notifications).toBeGreaterThan(0);
    expect(returningNotifications).toBeGreaterThan(0);
    unsubscribeReturning();

    const retry = startPullRequestAction(key, "merge", async () => {});
    expect(getPullRequestActionSnapshot().errorByKey.has(key)).toBe(false);
    await retry;
    expect(getPullRequestActionSnapshot().busyByKey.has(key)).toBe(false);
  });
});
