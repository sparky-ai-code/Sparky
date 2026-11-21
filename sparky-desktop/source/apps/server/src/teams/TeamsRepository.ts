/**
 * TeamsRepository - turns what a user types into a GitHub repository reference.
 *
 * Accepted forms:
 *   owner/name
 *   github.com/owner/name
 *   https://github.com/owner/name (optional trailing slash, `.git`, query, or
 *     a deeper path such as /tree/main)
 *   git@github.com:owner/name.git
 *
 * Pure TypeScript with no Effect dependency so it can be unit tested directly.
 *
 * @module TeamsRepository
 */

const NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const GITHUB_HOST_PATTERN = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i;
const SSH_PATTERN = /^git@github\.com:/i;

export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

/**
 * Parse a repository reference. Returns null when the input does not name a
 * GitHub repository; callers should ask the user for owner/name or a link.
 */
export function parseRepositoryInput(raw: string): RepositoryRef | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Links carry a host, so the path may continue past owner/name; a bare
  // owner/name must be exactly two segments.
  let path: string;
  let fromLink: boolean;
  if (SSH_PATTERN.test(trimmed)) {
    path = trimmed.replace(SSH_PATTERN, "");
    fromLink = true;
  } else if (GITHUB_HOST_PATTERN.test(trimmed)) {
    path = trimmed.replace(GITHUB_HOST_PATTERN, "");
    fromLink = true;
  } else {
    path = trimmed;
    fromLink = false;
  }

  const withoutQuery = path.split(/[?#]/)[0] ?? "";
  const segments = withoutQuery
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (fromLink ? segments.length < 2 : segments.length !== 2) {
    return null;
  }

  const owner = segments[0] ?? "";
  const name = (segments[1] ?? "").replace(/\.git$/i, "");
  if (!NAME_SEGMENT.test(owner) || !NAME_SEGMENT.test(name) || name.length === 0) {
    return null;
  }
  return { owner, name };
}
