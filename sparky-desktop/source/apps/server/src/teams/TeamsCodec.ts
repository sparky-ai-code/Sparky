/**
 * TeamsCodec - pure encoding/decoding helpers for GitHub-backed team messages.
 *
 * Everything here is plain TypeScript with no Effect runtime dependency so it
 * can be unit tested directly. Sparky-written GitHub comments and issue bodies
 * start with a hidden HTML comment marker line:
 *
 *   <!-- sparky-team:{"v":1,"kind":"message","replyTo":null} -->
 *   message text...
 *
 * Reactions are separate comments whose marker carries the target message id
 * and emoji, followed by a human readable line.
 *
 * @module TeamsCodec
 */
import type { TeamMessageReaction } from "@sparky/contracts";

export const TEAM_MARKER_VERSION = 1;
export const TEAM_THREAD_TITLE_MAX_LENGTH = 120;
const UNTITLED_THREAD_TITLE = "Untitled thread";

export interface TeamMarkerFieldsByKind {
  readonly message: { readonly replyTo: string | null };
  readonly reaction: { readonly target: string; readonly emoji: string };
}
export type TeamMarkerKind = keyof TeamMarkerFieldsByKind;

export type ParsedTeamMarker =
  | { readonly kind: "message"; readonly replyTo: string | null; readonly text: string }
  | {
      readonly kind: "reaction";
      readonly target: string;
      readonly emoji: string;
      readonly text: string;
    };

/** Minimal shape of a GitHub issue comment (or issue body) needed by the codec. */
export interface TeamCommentLike {
  readonly id: string;
  readonly author: string;
  readonly body: string;
}

/**
 * Encode the hidden marker line for a Sparky-written comment.
 * A literal `-->` inside the JSON is escaped so the HTML comment cannot close early.
 */
export function encodeMarker<K extends TeamMarkerKind>(
  kind: K,
  fields: TeamMarkerFieldsByKind[K],
): string {
  const json = JSON.stringify({ v: TEAM_MARKER_VERSION, kind, ...fields }).replace(
    /-->/g,
    "--\\u003e",
  );
  return `<!-- sparky-team:${json} -->`;
}

/** Body for a message (or thread root) comment: marker line, newline, text. */
export function encodeMessageBody(replyTo: string | null, text: string): string {
  return `${encodeMarker("message", { replyTo })}\n${text}`;
}

/** Body for a reaction comment: marker line, newline, human readable summary. */
export function encodeReactionBody(target: string, emoji: string): string {
  return `${encodeMarker("reaction", { target, emoji })}\nreacted ${emoji}`;
}

const MARKER_LINE_PATTERN = /^\s*<!-- sparky-team:(\{.*?\}) -->(?:\r?\n|$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parse the marker line of a comment body.
 * Returns null when the body has no valid Sparky marker (for example a comment
 * written by a human on github.com), so callers can treat it as plain text.
 */
export function parseMarker(body: string): ParsedTeamMarker | null {
  const match = MARKER_LINE_PATTERN.exec(body);
  if (match === null) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(match[1] ?? "");
  } catch {
    return null;
  }
  if (!isRecord(decoded) || decoded.v !== TEAM_MARKER_VERSION) {
    return null;
  }

  const text = body.slice(match[0].length);

  if (decoded.kind === "message") {
    const replyTo = decoded.replyTo;
    if (replyTo === undefined || replyTo === null) {
      return { kind: "message", replyTo: null, text };
    }
    if (isNonEmptyString(replyTo)) {
      return { kind: "message", replyTo, text };
    }
    return null;
  }

  if (decoded.kind === "reaction") {
    if (isNonEmptyString(decoded.target) && isNonEmptyString(decoded.emoji)) {
      return { kind: "reaction", target: decoded.target, emoji: decoded.emoji, text };
    }
    return null;
  }

  return null;
}

/**
 * Derive a thread (issue) title from a message body: the first non-empty line,
 * trimmed, truncated to 120 code points with a trailing ellipsis when longer.
 */
export function deriveThreadTitle(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return UNTITLED_THREAD_TITLE;
  }

  const characters = Array.from(firstLine);
  if (characters.length <= TEAM_THREAD_TITLE_MAX_LENGTH) {
    return firstLine;
  }
  return `${characters.slice(0, TEAM_THREAD_TITLE_MAX_LENGTH - 1).join("")}…`;
}

/**
 * Aggregate reaction comments into per-target reaction summaries.
 * Each author counts once per (target, emoji). Non-reaction comments are ignored.
 * Logins are compared case-insensitively, as GitHub does.
 */
export function aggregateReactions(
  comments: ReadonlyArray<Pick<TeamCommentLike, "author" | "body">>,
  viewerLogin: string | null,
): ReadonlyMap<string, ReadonlyArray<TeamMessageReaction>> {
  const viewerKey = viewerLogin === null ? null : viewerLogin.toLowerCase();
  const authorsByTarget = new Map<string, Map<string, Set<string>>>();

  for (const comment of comments) {
    const parsed = parseMarker(comment.body);
    if (parsed === null || parsed.kind !== "reaction") {
      continue;
    }
    const byEmoji = authorsByTarget.get(parsed.target) ?? new Map<string, Set<string>>();
    const authors = byEmoji.get(parsed.emoji) ?? new Set<string>();
    authors.add(comment.author.toLowerCase());
    byEmoji.set(parsed.emoji, authors);
    authorsByTarget.set(parsed.target, byEmoji);
  }

  const result = new Map<string, ReadonlyArray<TeamMessageReaction>>();
  for (const [target, byEmoji] of authorsByTarget) {
    const reactions: TeamMessageReaction[] = [];
    for (const [emoji, authors] of byEmoji) {
      reactions.push({
        emoji,
        count: authors.size,
        reactedByViewer: viewerKey !== null && authors.has(viewerKey),
      });
    }
    result.set(target, reactions);
  }
  return result;
}

/**
 * Find the id of the viewer's own reaction comment for a target and emoji,
 * or null when the viewer has not reacted with that emoji.
 */
export function findOwnReactionCommentId(
  comments: ReadonlyArray<TeamCommentLike>,
  viewerLogin: string,
  target: string,
  emoji: string,
): string | null {
  const viewerKey = viewerLogin.toLowerCase();
  for (const comment of comments) {
    if (comment.author.toLowerCase() !== viewerKey) {
      continue;
    }
    const parsed = parseMarker(comment.body);
    if (
      parsed !== null &&
      parsed.kind === "reaction" &&
      parsed.target === target &&
      parsed.emoji === emoji
    ) {
      return comment.id;
    }
  }
  return null;
}
