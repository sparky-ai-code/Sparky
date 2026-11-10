import type { SidebarThreadSummary } from "../types";
import { scopedThreadKey, scopeThreadRef } from "@sparky/client-runtime/environment";

/**
 * Only hide unattended agent work. Anything that needs a response, approval, or
 * error handling belongs in the main list even if the session is still running.
 * This is a sidebar presentation rule: it never pauses or stops a session.
 */
export function isFocusWorkingThread(thread: SidebarThreadSummary): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return false;
  }
  return (
    thread.session?.status === "starting" ||
    (thread.session?.status === "running" && thread.session.activeTurnId != null)
  );
}

export function partitionFocusThreads(input: {
  threads: readonly SidebarThreadSummary[];
  focusMode: boolean;
  pinnedThreadKeys: readonly string[];
  parkedThreadKeys: readonly string[];
}): {
  active: SidebarThreadSummary[];
  working: SidebarThreadSummary[];
  parked: SidebarThreadSummary[];
} {
  const active: SidebarThreadSummary[] = [];
  const working: SidebarThreadSummary[] = [];
  const parked: SidebarThreadSummary[] = [];
  const parkedKeys = new Set(input.parkedThreadKeys);
  const pinnedKeys = new Set(input.pinnedThreadKeys);

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (parkedKeys.has(key)) {
      parked.push(thread);
    } else if (input.focusMode && !pinnedKeys.has(key) && isFocusWorkingThread(thread)) {
      working.push(thread);
    } else {
      active.push(thread);
    }
  }

  return { active, working, parked };
}
