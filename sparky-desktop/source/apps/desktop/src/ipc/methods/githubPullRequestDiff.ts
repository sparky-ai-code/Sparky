// @effect-diagnostics globalFetch:off - GitHub diff retrieval is a small Electron main-process HTTP boundary.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { getGitHubOAuthToken } from "./githubCli.ts";

const GetPullRequestDiffInputSchema = Schema.Struct({
  repository: Schema.String,
  number: Schema.Number,
});

const PullRequestDiffResultSchema = Schema.Struct({
  diff: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

async function getPullRequestDiff(input: {
  repository: string;
  number: number;
}): Promise<typeof PullRequestDiffResultSchema.Type> {
  const token = await getGitHubOAuthToken();
  if (!token) return { diff: null, error: "GitHub OAuth authentication is required." };

  const [owner, repo] = input.repository.split("/", 2);
  if (!owner || !repo) return { diff: null, error: "Invalid GitHub repository name." };

  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.number}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3.diff",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Sparky-Desktop",
        },
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { diff: null, error: `Could not load code changes for ${input.repository}#${input.number}. GitHub API ${response.status}: ${detail || response.statusText}` };
    }
    return { diff: await response.text(), error: null };
  } catch (error) {
    return {
      diff: null,
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
