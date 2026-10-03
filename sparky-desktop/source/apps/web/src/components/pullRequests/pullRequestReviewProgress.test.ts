import { describe, expect, it } from "vite-plus/test";

import {
  getPullRequestReviewProgressSnapshot,
  startPullRequestReviewProgress,
  subscribeToPullRequestReviewProgress,
} from "./pullRequestReviewProgress.ts";

describe("pull request review progress", () => {
  it("keeps an active review and its live phase available after the page unsubscribes", async () => {
    const key = `example/project#${Date.now()}`;
    let releaseReview: () => void = () => {};
    let reviewNotifications = 0;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });

    const unsubscribe = subscribeToPullRequestReviewProgress(() => {
      reviewNotifications += 1;
    });
    const task = startPullRequestReviewProgress(key, async (report) => {
      report("reviewing", "Analyzing changed code for review findings…");
      await reviewGate;
      report("validating", "Checking findings against changed lines…");
      report("success", "Review posted.");
    });

    expect(task).not.toBeNull();
    expect(getPullRequestReviewProgressSnapshot().activeKey).toBe(key);
    expect(getPullRequestReviewProgressSnapshot().progressByKey.get(key)).toMatchObject({
      phase: "fetching",
      message: "Fetching the latest pull-request changes from GitHub…",
    });
    expect(startPullRequestReviewProgress("another/project#1", async () => {})).toBeNull();

    await Promise.resolve();
    expect(getPullRequestReviewProgressSnapshot().progressByKey.get(key)).toMatchObject({
      phase: "reviewing",
      message: "Analyzing changed code for review findings…",
    });

    unsubscribe();
    let returningNotifications = 0;
    const unsubscribeReturningSubscriber = subscribeToPullRequestReviewProgress(() => {
      returningNotifications += 1;
    });
    expect(getPullRequestReviewProgressSnapshot().activeKey).toBe(key);
    expect(getPullRequestReviewProgressSnapshot().progressByKey.get(key)?.message).toBe(
      "Analyzing changed code for review findings…",
    );

    releaseReview();
    await task;

    expect(getPullRequestReviewProgressSnapshot().activeKey).toBeNull();
    expect(getPullRequestReviewProgressSnapshot().progressByKey.get(key)).toMatchObject({
      phase: "success",
      message: "Review posted.",
    });
    expect(reviewNotifications).toBeGreaterThan(0);
    expect(returningNotifications).toBeGreaterThan(0);
    unsubscribeReturningSubscriber();
  });

  it("keeps task failures visible and releases the active slot", async () => {
    const key = `example/project#error-${Date.now()}`;
    const task = startPullRequestReviewProgress(key, async () => {
      throw new Error("The review request failed.");
    });

    expect(task).not.toBeNull();
    await task;

    expect(getPullRequestReviewProgressSnapshot().activeKey).toBeNull();
    expect(getPullRequestReviewProgressSnapshot().progressByKey.get(key)).toMatchObject({
      phase: "error",
      message: "The review request failed.",
    });
  });
});
