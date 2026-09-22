import { scopeThreadRef } from "@sparky/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@sparky/contracts";
import { describe, expect, it } from "vite-plus/test";
import { sameSplitChatThread, splitChatTargetForSide } from "./splitChatStore";

const thread = (environmentId: string, threadId: string) =>
  scopeThreadRef(environmentId as EnvironmentId, threadId as ThreadId);

describe("split chat layout", () => {
  it("places the dragged chat on the requested side", () => {
    const current = thread("local", "current");
    const dragged = thread("local", "dragged");

    expect(splitChatTargetForSide("left", current, dragged)).toEqual({
      left: dragged,
      right: current,
    });
    expect(splitChatTargetForSide("right", current, dragged)).toEqual({
      left: current,
      right: dragged,
    });
  });

  it("compares the complete environment/thread identity", () => {
    expect(sameSplitChatThread(thread("local", "one"), thread("local", "one"))).toBe(true);
    expect(sameSplitChatThread(thread("local", "one"), thread("remote", "one"))).toBe(false);
    expect(sameSplitChatThread(thread("local", "one"), null)).toBe(false);
  });
});
