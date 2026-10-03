// @effect-diagnostics globalFetch:off - GitHub diff retrieval is a small Electron main-process HTTP boundary.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { getGitHubOAuthToken, parseGitHubRepository } from "./githubCli.ts";

const GetPullRequestDiffInputSchema = Schema.Struct({
  repository: Schema.String,
  number: Schema.Number,
});

const PullRequestDiffResultSchema = Schema.Struct({
  diff: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

async function getPullRequestDiff(input: {
  repository: string;
  number: number;
}): Promise<typeof PullRequestDiffResultSchema.Type> {
  const token = await getGitHubOAuthToken();
  if (!token) {
    return { diff: null, headSha: null, error: "GitHub OAuth authentication is required." };
  }

  const repository = parseGitHubRepository(input.repository);
  if (!repository || !Number.isSafeInteger(input.number) || input.number < 1) {
    return { diff: null, headSha: null, error: "Invalid GitHub pull request." };
  }
  const { owner, repo } = repository;

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.number}`;
  try {
    const pullRequestResponse = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Sparky-Desktop",
      },
    });
    if (!pullRequestResponse.ok) {
      const detail = await pullRequestResponse.text().catch(() => "");
      return {
        diff: null,
        headSha: null,
        error: `Could not load pull request ${input.repository}#${input.number}. GitHub API ${pullRequestResponse.status}: ${detail || pullRequestResponse.statusText}`,
      };
    }
    const pullRequest: unknown = await pullRequestResponse.json();
    const head =
      typeof pullRequest === "object" && pullRequest !== null && "head" in pullRequest
        ? pullRequest.head
        : null;
    const headSha =
      typeof head === "object" && head !== null && "sha" in head && typeof head.sha === "string"
        ? head.sha
        : null;
    if (!headSha) {
      return {
        diff: null,
        headSha: null,
        error: "GitHub did not provide the pull request head commit.",
      };
    }

    const diffResponse = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3.diff",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Sparky-Desktop",
      },
    });
    if (!diffResponse.ok) {
      const detail = await diffResponse.text().catch(() => "");
      return {
        diff: null,
        headSha: null,
        error: `Could not load code changes for ${input.repository}#${input.number}. GitHub API ${diffResponse.status}: ${detail || diffResponse.statusText}`,
      };
    }
    const diff = await diffResponse.text();
    const headCheckResponse = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Sparky-Desktop",
      },
    });
    if (!headCheckResponse.ok) {
      const detail = await headCheckResponse.text().catch(() => "");
      return {
        diff: null,
        headSha: null,
        error: `Could not verify the pull request head for ${input.repository}#${input.number}. GitHub API ${headCheckResponse.status}: ${detail || headCheckResponse.statusText}`,
      };
    }
    const latestPullRequest: unknown = await headCheckResponse.json();
    const latestHead =
      typeof latestPullRequest === "object" && latestPullRequest !== null && "head" in latestPullRequest
        ? latestPullRequest.head
        : null;
    const latestHeadSha =
      typeof latestHead === "object" && latestHead !== null && "sha" in latestHead && typeof latestHead.sha === "string"
        ? latestHead.sha
        : null;
    if (!latestHeadSha || latestHeadSha !== headSha) {
      return {
        diff: null,
        headSha: null,
        error: "The pull request changed while its code changes were loading. Reload the pull request and try again.",
      };
    }
    return { diff, headSha, error: null };
  } catch (error) {
    return {
      diff: null,
      headSha: null,
      error: `Could not load code changes for ${input.repository}#${input.number}. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const getPullRequestDiffMethod = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GITHUB_CLI_GET_PULL_REQUEST_DIFF_CHANNEL,
  payload: GetPullRequestDiffInputSchema,
  result: PullRequestDiffResultSchema,
  handler: (input) => Effect.tryPromise(() => getPullRequestDiff(input)),
});
