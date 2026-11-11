import { describe, expect, it } from "vite-plus/test";
import { availableExistingWorktrees, resolveNewThreadWorkspace } from "./newThreadSetup";

const refs = [
  { name: "main", worktreePath: "/repo" },
  { name: "feature/a", worktreePath: "/repo/.worktrees/a" },
  { name: "feature/b", worktreePath: "/repo/.worktrees/b" },
  { name: "origin/develop", worktreePath: null },
] as const;

describe("cross-project new thread workspace setup", () => {
  it("keeps the current checkout instead of silently switching branches", () => {
    expect(
      resolveNewThreadWorkspace({
        choice: "current",
        currentBranch: "main",
        selectedBranch: "feature/a",
        selectedWorktreePath: "/repo/.worktrees/a",
        projectRoot: "/repo",
        refs,
      }),
    ).toEqual({ branch: "main", worktreePath: null, envMode: "local" });
  });

  it("sets a base branch and no path when a new worktree is requested", () => {
    expect(
      resolveNewThreadWorkspace({
        choice: "new-worktree",
        currentBranch: "main",
        selectedBranch: "origin/develop",
        selectedWorktreePath: null,
        projectRoot: "/repo",
        refs,
      }),
    ).toEqual({ branch: "origin/develop", worktreePath: null, envMode: "worktree" });
  });

  it("rejects a missing or unlisted base branch", () => {
    expect(
      resolveNewThreadWorkspace({
        choice: "new-worktree",
        currentBranch: null,
        selectedBranch: "missing",
        selectedWorktreePath: null,
        projectRoot: "/repo",
        refs,
      }),
    ).toBeNull();
  });

  it("reuses a listed existing worktree without creating another", () => {
    expect(
      resolveNewThreadWorkspace({
        choice: "existing-worktree",
        currentBranch: "main",
        selectedBranch: null,
        selectedWorktreePath: "/repo/.worktrees/a",
        projectRoot: "/repo",
        refs,
      }),
    ).toEqual({ branch: "feature/a", worktreePath: "/repo/.worktrees/a", envMode: "local" });
  });

  it("rejects arbitrary worktree paths and excludes the main checkout", () => {
    expect(availableExistingWorktrees(refs, "/repo")).toHaveLength(2);
    expect(
      resolveNewThreadWorkspace({
        choice: "existing-worktree",
        currentBranch: "main",
        selectedBranch: null,
        selectedWorktreePath: "/tmp/not-a-worktree",
        projectRoot: "/repo",
        refs,
      }),
    ).toBeNull();
  });
});
