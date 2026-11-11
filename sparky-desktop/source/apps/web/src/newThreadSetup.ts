import type { VcsRef } from "@sparky/contracts";
import type { DraftThreadEnvMode } from "./composerDraftStore";

/**
 * Worktree choices must resolve to an executable draft context. A new worktree
 * has a base branch but no path until the first turn prepares it; an existing
 * worktree has an exact path and must never trigger worktree preparation.
 */
export type ThreadWorkspaceChoice = "current" | "new-worktree" | "existing-worktree";

export interface NewThreadWorkspaceInput {
  choice: ThreadWorkspaceChoice;
  currentBranch: string | null;
  selectedBranch: string | null;
  selectedWorktreePath: string | null;
  projectRoot: string;
  refs: ReadonlyArray<Pick<VcsRef, "name" | "worktreePath">>;
}

export interface ResolvedThreadWorkspace {
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
}

export function availableExistingWorktrees(
  refs: ReadonlyArray<Pick<VcsRef, "name" | "worktreePath">>,
  projectRoot: string,
): ReadonlyArray<Pick<VcsRef, "name" | "worktreePath">> {
  const normalizedRoot = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!ref.worktreePath) return false;
    const normalizedPath = ref.worktreePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (normalizedPath === normalizedRoot || seen.has(normalizedPath)) return false;
    seen.add(normalizedPath);
    return true;
  });
}

export function resolveNewThreadWorkspace(
  input: NewThreadWorkspaceInput,
): ResolvedThreadWorkspace | null {
  if (input.choice === "current") {
    return {
      branch: input.currentBranch,
      worktreePath: null,
      envMode: "local",
    };
  }
  if (input.choice === "new-worktree") {
    const branch = input.selectedBranch?.trim() || input.currentBranch?.trim() || null;
    if (!branch || !input.refs.some((ref) => ref.name === branch)) return null;
    return {
      branch,
      worktreePath: null,
      envMode: "worktree",
    };
  }
  const ref = availableExistingWorktrees(input.refs, input.projectRoot).find(
    (candidate) => candidate.worktreePath === input.selectedWorktreePath,
  );
  if (!ref) return null;
  return {
    branch: ref.name,
    worktreePath: ref.worktreePath,
    envMode: "local",
  };
}
