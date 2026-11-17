import { describe, expect, it } from "@effect/vitest";

import {
  THREAD_DETAIL_REPLAY_MAX_EVENTS,
  threadDetailReplayLimit,
} from "./threadResumeStrategy.ts";

describe("threadDetailReplayLimit", () => {
  it("resumes a current cursor without reading history", () => {
    expect(threadDetailReplayLimit(200, 200)).toBe(0);
  });

  it("allows a bounded replay across global thread events", () => {
    expect(threadDetailReplayLimit(200, 235)).toBe(35);
    expect(threadDetailReplayLimit(200, 200 + THREAD_DETAIL_REPLAY_MAX_EVENTS)).toBe(
      THREAD_DETAIL_REPLAY_MAX_EVENTS,
    );
  });

  it("prefers a fresh projection when a cached cursor is stale or invalid", () => {
    expect(threadDetailReplayLimit(200, 201 + THREAD_DETAIL_REPLAY_MAX_EVENTS)).toBeNull();
    expect(threadDetailReplayLimit(201, 200)).toBeNull();
    expect(threadDetailReplayLimit(0, Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});
