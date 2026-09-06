import * as Schema from "effect/Schema";

export const SCHEDULE_FREQUENCIES = ["hourly", "daily", "weekly", "once"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export const WEEKDAY_OPTIONS = [
  { value: "monday", label: "Mondays" },
  { value: "tuesday", label: "Tuesdays" },
  { value: "wednesday", label: "Wednesdays" },
  { value: "thursday", label: "Thursdays" },
  { value: "friday", label: "Fridays" },
  { value: "saturday", label: "Saturdays" },
  { value: "sunday", label: "Sundays" },
] as const;
export type Weekday = (typeof WEEKDAY_OPTIONS)[number]["value"];

export type ScheduledTaskAccent = "blue" | "violet" | "green";

export interface ScheduledTask {
  id: string;
  title: string;
  description: string;
  frequency: ScheduleFrequency;
  intervalHours: number;
  time: string;
  dayOfWeek: Weekday;
  date: string;
  nextRunLabel: string;
  scheduleLabel: string;
  statusLabel: string;
  active: boolean;
  accent: ScheduledTaskAccent;
}

export const ScheduledTaskSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  frequency: Schema.Literals(["hourly", "daily", "weekly", "once"]),
  intervalHours: Schema.Number,
  time: Schema.String,
  dayOfWeek: Schema.Literals([
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ]),
  date: Schema.String,
  nextRunLabel: Schema.String,
  scheduleLabel: Schema.String,
  statusLabel: Schema.String,
  active: Schema.Boolean,
  accent: Schema.Literals(["blue", "violet", "green"]),
});

export const ScheduledTaskListSchema = Schema.Array(ScheduledTaskSchema);

export const SCHEDULED_TASKS_STORAGE_KEY = "sparky.scheduled-tasks";
export const SCHEDULED_TASKS_SUGGESTION_CYCLE_STORAGE_KEY =
  "sparky.scheduled-tasks.suggestion-cycle";

export const DEFAULT_SCHEDULED_TASKS: ScheduledTask[] = [];

export interface ScheduleTiming {
  frequency: ScheduleFrequency;
  intervalHours: number;
  time: string;
  dayOfWeek: Weekday;
  date: string;
}

export interface ScheduleDraft extends ScheduleTiming {
  title: string;
  prompt: string;
}

export function formatTimeLabel(value: string): string {
  const [hoursText, minutesText] = value.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return value;
  }

  const period = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes.toString().padStart(2, "0")} ${period}`;
}

export function formatDateLabel(value: string): string {
  if (!value) return "a future date";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatWeekdayLabel(value: string): string {
  return WEEKDAY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function formatScheduleSummary(timing: ScheduleTiming): string {
  switch (timing.frequency) {
    case "hourly": {
      const interval = Math.max(1, Math.round(timing.intervalHours));
      return `Every ${interval} hour${interval === 1 ? "" : "s"}`;
    }
    case "daily":
      return timing.time ? `Every day at ${formatTimeLabel(timing.time)}` : "Every day";
    case "weekly":
      return `${formatWeekdayLabel(timing.dayOfWeek)} at ${formatTimeLabel(timing.time)}`;
    case "once":
      return `Once on ${formatDateLabel(timing.date)} at ${formatTimeLabel(timing.time)}`;
  }
}

export function getNextRunLabel(timing: ScheduleTiming): string {
  switch (timing.frequency) {
    case "hourly": {
      const interval = Math.max(1, Math.round(timing.intervalHours));
      return `Next run in ${interval} hour${interval === 1 ? "" : "s"}`;
    }
    case "daily":
      return timing.time ? `Next run at ${formatTimeLabel(timing.time)}` : "Next run every day";
    case "weekly":
      return `Next run ${formatWeekdayLabel(timing.dayOfWeek)} at ${formatTimeLabel(timing.time)}`;
    case "once":
      return `Next run ${formatDateLabel(timing.date)} at ${formatTimeLabel(timing.time)}`;
  }
}

export function buildScheduledTask(
  draft: ScheduleDraft,
  id: string,
  accent: ScheduledTaskAccent,
): ScheduledTask {
  const intervalHours = Math.max(1, Number.parseInt(draft.intervalHours.toString(), 10) || 1);
  const timing = { ...draft, intervalHours };
  return {
    id,
    title: draft.title.trim(),
    description: draft.prompt.trim(),
    frequency: draft.frequency,
    intervalHours,
    time: draft.time,
    dayOfWeek: draft.dayOfWeek,
    date: draft.date,
    nextRunLabel: getNextRunLabel(timing),
    scheduleLabel: "Scheduled task",
    statusLabel: "Scheduled",
    active: true,
    accent,
  };
}

export function removePreloadedScheduledTasks(tasks: readonly ScheduledTask[]): ScheduledTask[] {
  return tasks.filter((task) => task.id !== "gpt-watch" && task.id !== "gemini-watch");
}

export function selectCycledSuggestions<T>(
  suggestions: readonly T[],
  startIndex: number,
  count: number,
): T[] {
  if (suggestions.length === 0 || count <= 0) return [];

  const normalizedStart =
    ((Math.trunc(startIndex) % suggestions.length) + suggestions.length) % suggestions.length;
  return Array.from(
    { length: Math.min(count, suggestions.length) },
    (_, offset) => suggestions[(normalizedStart + offset) % suggestions.length],
  ).filter((suggestion): suggestion is T => suggestion !== undefined);
}

export function matchesScheduledTask(task: ScheduledTask, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    task.title,
    task.description,
    task.statusLabel,
    task.scheduleLabel,
    formatScheduleSummary(task),
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
}
