/**
 * Pure helpers for the Teams UI. Nothing in this file touches React, so it can be
 * unit tested directly and reused by any component.
 */

/** Title of the one team-wide chat thread. Its title never changes, so the chat stays the same. */
export const TEAM_CHAT_TITLE = "Team chat";

/** Icon names for suggested prompts. The component maps each name to a lucide icon. */
export type TeamPromptIcon =
  | "pull-request"
  | "bug"
  | "checklist"
  | "message"
  | "calendar"
  | "alert"
  | "file"
  | "list"
  | "users";

export interface TeamPrompt {
  readonly text: string;
  readonly icon: TeamPromptIcon;
}

/** Pool of suggested prompts. Each time the Teams page opens, a few are picked from here. */
export const TEAM_PROMPT_POOL: readonly TeamPrompt[] = [
  { text: "Summarize open pull requests and what needs review", icon: "pull-request" },
  { text: "Open an issue for a bug we saw today", icon: "bug" },
  { text: "Plan a feature and split it into tasks", icon: "checklist" },
  { text: "Review the latest PR and leave comments", icon: "message" },
  { text: "Write a standup update for the team", icon: "calendar" },
  { text: "What is blocking the next release?", icon: "alert" },
  { text: "Draft release notes for what shipped this week", icon: "file" },
  { text: "List stale issues that can be closed", icon: "list" },
  { text: "Break this idea into small reviewable PRs", icon: "pull-request" },
  { text: "Who should review the open pull requests?", icon: "users" },
];

export const SUGGESTED_PROMPT_COUNT = 3;

/**
 * Pick `count` distinct prompts from `pool`. `random` returns a number in [0, 1); it is
 * injectable so tests can check the result.
 */
export function pickSuggestedPrompts<T>(
  pool: readonly T[],
  count: number,
  random: () => number = Math.random,
): T[] {
  const remaining = [...pool];
  const picked: T[] = [];
  while (picked.length < count && remaining.length > 0) {
    const index = Math.min(remaining.length - 1, Math.floor(random() * remaining.length));
    const [item] = remaining.splice(index, 1);
    if (item !== undefined) {
      picked.push(item);
    }
  }
  return picked;
}

export const REACTION_EMOJIS = ["👍", "❤️", "🎉", "👀", "🚀", "😂"] as const;

const THREAD_TITLE_MAX_CHARS = 120;
const UNTITLED_THREAD_TITLE = "Untitled thread";

/** First non-empty trimmed line of a message body, truncated to 120 characters. */
export function threadTitleFromBody(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return UNTITLED_THREAD_TITLE;
  }
  // Count code points so an emoji is never split in half.
  const characters = Array.from(firstLine);
  if (characters.length <= THREAD_TITLE_MAX_CHARS) {
    return firstLine;
  }
  return `${characters.slice(0, THREAD_TITLE_MAX_CHARS - 1).join("")}…`;
}

function isShallowEqual(a: object, b: object): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      return false;
    }
    const aValue: unknown = (a as Record<string, unknown>)[key];
    const bValue: unknown = (b as Record<string, unknown>)[key];
    if (aValue === bValue) {
      continue;
    }
    // Nested arrays/objects (for example `reactions`) arrive as new references on every
    // poll, so compare their content instead.
    if (
      typeof aValue === "object" &&
      aValue !== null &&
      typeof bValue === "object" &&
      bValue !== null &&
      JSON.stringify(aValue) === JSON.stringify(bValue)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Builds the list in `incoming` order. Items that are shallowly equal to their
 * previous version keep the previous object reference. When nothing changed, the
 * `previous` array itself is returned so React can bail out of re-rendering.
 */
export function mergeById<T extends { readonly id: string }>(
  previous: readonly T[],
  incoming: readonly T[],
): T[] {
  const previousById = new Map<string, T>();
  for (const item of previous) {
    previousById.set(item.id, item);
  }

  const merged = incoming.map((item) => {
    const existing = previousById.get(item.id);
    return existing !== undefined && isShallowEqual(existing, item) ? existing : item;
  });

  const unchanged =
    merged.length === previous.length && merged.every((item, index) => item === previous[index]);
  if (unchanged) {
    return previous as T[];
  }
  return merged;
}

/**
 * Number of messages after `lastReadId` (in array order) that were not written by the
 * viewer. A null `lastReadId` means the thread was never opened, so return 0 instead
 * of flooding a new user with unread counts. If `lastReadId` is no longer in the list,
 * every message not written by the viewer counts as unread.
 */
export function countUnread(
  messages: readonly { readonly id: string; readonly author: string }[],
  lastReadId: string | null,
  viewerLogin: string | null,
): number {
  if (lastReadId === null) {
    return 0;
  }
  const lastReadIndex = messages.findIndex((message) => message.id === lastReadId);
  const start = lastReadIndex === -1 ? 0 : lastReadIndex + 1;
  let count = 0;
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (message !== undefined && message.author !== viewerLogin) {
      count += 1;
    }
  }
  return count;
}

/** The team to open by default. A single team opens directly. */
export function pickDefaultTeam<T extends { readonly id: string }>(teams: readonly T[]): T | null {
  return teams[0] ?? null;
}

export function teamsViewMode(teamCount: number): "empty" | "single" | "list" {
  if (teamCount <= 0) {
    return "empty";
  }
  if (teamCount === 1) {
    return "single";
  }
  return "list";
}

export const LAST_SEEN_STORAGE_KEY = "sparky.teams.lastSeen.v1";

function isPlainStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

/** Map of `${projectId}#${threadId}` to the last message id the viewer has read. */
export function readLastSeenMap(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_SEEN_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    return isPlainStringMap(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

/** Records the last read message for a thread. Never throws. */
export function writeLastSeen(threadKey: string, messageId: string): void {
  try {
    const map = readLastSeenMap();
    map[threadKey] = messageId;
    globalThis.localStorage?.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable (private mode, blocked storage). Ignore.
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RELATIVE_DAYS_LIMIT = 7;

/**
 * "just now", "5m ago", "3h ago", "2d ago". Timestamps a week old or more show a locale
 * date. Invalid input is returned unchanged.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return iso;
  }
  const elapsed = now.getTime() - time;
  if (elapsed < MINUTE_MS) {
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }
  if (elapsed < RELATIVE_DAYS_LIMIT * DAY_MS) {
    return `${Math.floor(elapsed / DAY_MS)}d ago`;
  }
  return new Date(time).toLocaleDateString();
}
