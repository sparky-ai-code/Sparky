import { describe, expect, it } from "vite-plus/test";
import { isTopLevelThreadShell } from "./threadShell.ts";

describe("in-thread subagents", () => {
  it("keeps ordinary threads in navigation but not their child agents", () => {
    expect(isTopLevelThreadShell({})).toBe(true);
    expect(isTopLevelThreadShell({ parentThreadId: undefined })).toBe(true);
    expect(isTopLevelThreadShell({ parentThreadId: "parent-thread" as never })).toBe(false);
  });
});
