import { describe, expect, it } from "vite-plus/test";

import { findPullRequestReviewWorkspace } from "./pullRequestReview.ts";

describe("pull request review prompt", () => {
  it("uses a primary workspace even when the reviewed repository is not local", () => {
    const primaryWorkspace = {
      environmentId: "primary",
      repositoryIdentity: { owner: "darkness22s", name: "Sparky" },
    };
    const secondaryWorkspace = {
      environmentId: "secondary",
      repositoryIdentity: { owner: "octocat", name: "hello-world" },
    };

    expect(findPullRequestReviewWorkspace([secondaryWorkspace, primaryWorkspace], "primary")).toBe(
      primaryWorkspace,
    );
    expect(findPullRequestReviewWorkspace([secondaryWorkspace], "primary")).toBeNull();
  });
});
