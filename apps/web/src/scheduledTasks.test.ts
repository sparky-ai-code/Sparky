import { describe, expect, it } from "vite-plus/test";

import {
  buildScheduledTask,
  formatScheduleSummary,
  formatTimeLabel,
  getNextRunLabel,
  matchesScheduledTask,
  removePreloadedScheduledTasks,
  selectCycledSuggestions,
  type ScheduleDraft,
} from "./scheduledTasks";

const baseDraft: ScheduleDraft = {
  title: "  Morning brief  ",
  prompt: "  Summarize my priorities.  ",
  frequency: "daily",
  intervalHours: 1,
  time: "08:00",
  dayOfWeek: "monday",
  date: "2027-01-08",
};

describe("scheduled task formatting", () => {
  it("formats times using the user's familiar 12-hour clock", () => {
    expect(formatTimeLabel("00:05")).toBe("12:05 AM");
    expect(formatTimeLabel("12:30")).toBe("12:30 PM");
    expect(formatTimeLabel("18:45")).toBe("6:45 PM");
  });

  it("describes looping, daily, weekday, and one-time schedules", () => {
    expect(formatScheduleSummary({ ...baseDraft, frequency: "hourly", intervalHours: 2 })).toBe(
      "Every 2 hours",
    );
    expect(formatScheduleSummary(baseDraft)).toBe("Every day at 8:00 AM");
    expect(formatScheduleSummary({ ...baseDraft, frequency: "weekly", dayOfWeek: "friday" })).toBe(
      "Fridays at 8:00 AM",
    );
    expect(formatScheduleSummary({ ...baseDraft, frequency: "once" })).toContain("Once on");
  });

  it("builds a normalized task and derives its next run label", () => {
    const task = buildScheduledTask(
      { ...baseDraft, frequency: "hourly", intervalHours: 3 },
      "task-1",
      "blue",
    );

    expect(task).toMatchObject({
      id: "task-1",
      title: "Morning brief",
      description: "Summarize my priorities.",
      frequency: "hourly",
      intervalHours: 3,
      nextRunLabel: "Next run in 3 hours",
      active: true,
    });
  });
});

describe("scheduled task migration", () => {
  it("removes the legacy fake watch tasks without touching user tasks", () => {
    const task = buildScheduledTask(baseDraft, "user-task", "blue");
    const cleaned = removePreloadedScheduledTasks([
      { ...task, id: "gpt-watch" },
      { ...task, id: "gemini-watch" },
      task,
    ]);

    expect(cleaned).toEqual([task]);
  });
});

describe("suggestion rotation", () => {
  it("cycles through suggestions and wraps at the end", () => {
    expect(selectCycledSuggestions(["a", "b", "c", "d"], 3, 3)).toEqual(["d", "a", "b"]);
    expect(selectCycledSuggestions(["a", "b", "c", "d"], -1, 2)).toEqual(["d", "a"]);
  });
});

describe("matchesScheduledTask", () => {
  const task = buildScheduledTask(baseDraft, "task-1", "violet");

  it("searches task content and cadence details", () => {
    expect(matchesScheduledTask(task, "priorities")).toBe(true);
    expect(matchesScheduledTask(task, "every day at 8:00")).toBe(true);
    expect(matchesScheduledTask(task, "weekly")).toBe(false);
    expect(matchesScheduledTask(task, "")).toBe(true);
  });
});
