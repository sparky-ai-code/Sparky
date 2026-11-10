import { describe, expect, it } from "vite-plus/test";
import { scopedThreadKey, scopeThreadRef } from "@sparky/client-runtime/environment";
import type { SidebarThreadSummary } from "../types";
import { isFocusWorkingThread, partitionFocusThreads } from "./Sidebar.focus.logic";

function thread(id: string, overrides: Record<string, unknown> = {}): SidebarThreadSummary {
  return {
    id,
    environmentId: "local",
    title: id,
    archivedAt: null,
    session: { status: "idle", activeTurnId: null },
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    ...overrides,
  } as unknown as SidebarThreadSummary;
}

const key = (item: SidebarThreadSummary) =>
  scopedThreadKey(scopeThreadRef(item.environmentId, item.id));

describe("Focus sidebar partitions", () => {
  const running = thread("running", { session: { status: "running", activeTurnId: "turn-1" } });
  const finished = thread("finished");
  const needsInput = thread("input", {
    session: { status: "running", activeTurnId: "turn-2" },
    hasPendingUserInput: true,
  });
  const needsApproval = thread("approval", {
    session: { status: "running", activeTurnId: "turn-3" },
    hasPendingApprovals: true,
  });

  it("keeps working agent runs in the collapsed shelf while bringing actionable work back", () => {
    const result = partitionFocusThreads({
      threads: [running, needsInput, needsApproval, finished],
      focusMode: true,
      pinnedThreadKeys: [],
      parkedThreadKeys: [],
    });
    expect(result.working.map((t) => t.id)).toEqual(["running"]);
    expect(result.active.map((t) => t.id)).toEqual(["input", "approval", "finished"]);
    expect(isFocusWorkingThread(thread("starting", { session: { status: "starting" } }))).toBe(true);
  });

  it("never hides pinned work and restores completed work to the main list", () => {
    expect(partitionFocusThreads({
      threads: [running, finished],
      focusMode: true,
      pinnedThreadKeys: [key(running)],
      parkedThreadKeys: [],
    }).active).toEqual([running, finished]);
    expect(partitionFocusThreads({
      threads: [finished],
      focusMode: true,
      pinnedThreadKeys: [],
      parkedThreadKeys: [],
    }).working).toEqual([]);
  });

  it("keeps manually parked threads out of active work even when Focus Mode is off", () => {
    const result = partitionFocusThreads({
      threads: [running, finished],
      focusMode: false,
      pinnedThreadKeys: [],
      parkedThreadKeys: [key(running)],
    });
    expect(result.parked).toEqual([running]);
    expect(result.active).toEqual([finished]);
  });

  it("ignores archived threads and doesn't hide errors", () => {
    const failure = thread("failure", { session: { status: "error" } });
    const result = partitionFocusThreads({
      threads: [failure, thread("archived", { archivedAt: "2026-11-10T00:00:00Z" })],
      focusMode: true,
      pinnedThreadKeys: [],
      parkedThreadKeys: [],
    });
    expect(result.active).toEqual([failure]);
    expect(result.working).toEqual([]);
    expect(result.parked).toEqual([]);
  });
});
