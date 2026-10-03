// @effect-diagnostics nodeBuiltinImport:off - Electron's credential file is seeded through a temporary Node filesystem for integration coverage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => ""),
}));

vi.mock("electron", () => ({
  app: { getPath: getPathMock },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
  shell: { openExternal: vi.fn() },
}));

const HEAD_SHA = "a".repeat(40);
const PULL_REQUEST_PATH = "/repos/example/project/pulls/17";
const DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1 +1,2 @@",
  " existingLine();",
  "+addedLine();",
  "",
].join("\n");

type PostedReview = {
  readonly body: string;
  readonly comments: ReadonlyArray<{ readonly path: string; readonly line: number }>;
};

let userDataPath: string;
let fetchMock: ReturnType<typeof vi.fn>;
let postedReviews: PostedReview[];
let pullRequestHeadShas: string[];

function makeGitHubResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function setupGitHubMock(headShas: string[]): void {
  pullRequestHeadShas = [...headShas];
  postedReviews = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/user") return makeGitHubResponse({ login: "sparky-test" });
    if (url.pathname.endsWith("/check-runs")) {
      return makeGitHubResponse({
        total_count: 2,
        check_runs: [{ conclusion: "success" }, { conclusion: "failure" }],
      });
    }
    if (url.pathname.endsWith("/status")) {
      return makeGitHubResponse({
        total_count: 1,
        statuses: [{ state: "error" }],
      });
    }
    if (url.pathname === `${PULL_REQUEST_PATH}/reviews` && init?.method === "POST") {
      postedReviews.push(JSON.parse(String(init.body)) as PostedReview);
      return makeGitHubResponse({ id: 1 });
    }
    if (url.pathname === PULL_REQUEST_PATH) {
      const accept = new Headers(init?.headers).get("Accept");
      if (accept === "application/vnd.github.v3.diff") return new Response(DIFF, { status: 200 });
      return makeGitHubResponse({
        number: 17,
        title: "Test pull request",
        html_url: "https://github.com/example/project/pull/17",
        state: "open",
        updated_at: "2026-10-01T00:00:00Z",
        created_at: "2026-09-30T00:00:00Z",
        head: { sha: pullRequestHeadShas.shift() ?? HEAD_SHA, ref: "feature" },
        base: { ref: "main" },
        comments: 2,
        review_comments: 3,
      });
    }
    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function loadGitHubCli() {
  vi.resetModules();
  return import("./githubCli.ts");
}

beforeEach(async () => {
  userDataPath = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sparky-github-review-"));
  getPathMock.mockReturnValue(userDataPath);
  vi.stubEnv("SPARKY_GITHUB_CLIENT_ID", "test-client-id");
  vi.stubEnv("SPARKY_GITHUB_AUTH_BROKER_URL", "https://auth.sparky.test");
  await NodeFSP.writeFile(
    NodePath.join(userDataPath, "github-auth-credentials.bin"),
    Buffer.from(
      JSON.stringify({
        version: 1,
        accessToken: "test-access-token-value-long-enough",
        tokenType: "bearer",
        expiresAt: 4_000_000_000_000,
        refreshToken: null,
        refreshTokenExpiresAt: null,
      }),
    ),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await NodeFSP.rm(userDataPath, { recursive: true, force: true });
});

describe("GitHub pull request details", () => {
  effectIt.effect("loads conversation comments, inline comments, and commit checks", () =>
    Effect.gen(function* () {
      setupGitHubMock([HEAD_SHA]);
      const { getPullRequestMethod } = yield* Effect.promise(() => loadGitHubCli());

      const result = yield* getPullRequestMethod.handler({
        repository: "example/project",
        number: 17,
      });

      expect(result).toMatchObject({
        pullRequest: {
          commentsCount: 2,
          reviewsCount: 3,
          checksCount: 3,
          failedChecksCount: 2,
        },
      });
    }),
  );
});

describe("GitHub pull request review submission", () => {
  effectIt.effect(
    "rejects a review if the pull request head changes while validating the diff",
    () =>
      Effect.gen(function* () {
        setupGitHubMock([HEAD_SHA, "b".repeat(40)]);
        const { postPullRequestReviewMethod } = yield* Effect.promise(() => loadGitHubCli());

        const result = yield* postPullRequestReviewMethod.handler({
          repository: "example/project",
          number: 17,
          expectedHeadSha: HEAD_SHA,
          summary: "One actionable issue was found.",
          findings: [
            {
              path: "src/example.ts",
              line: 2,
              severity: "high",
              title: "Handle the error",
              body: "The call can fail without handling the result.",
            },
          ],
        });

        expect(result).toMatchObject({ error: expect.stringContaining("changed during review") });
        expect(postedReviews).toHaveLength(0);
      }),
  );

  effectIt.effect(
    "rejects a review when no finding points to an added line in the current diff",
    () =>
      Effect.gen(function* () {
        setupGitHubMock([HEAD_SHA, HEAD_SHA]);
        const { postPullRequestReviewMethod } = yield* Effect.promise(() => loadGitHubCli());

        const result = yield* postPullRequestReviewMethod.handler({
          repository: "example/project",
          number: 17,
          expectedHeadSha: HEAD_SHA,
          summary: "One finding was outside the changed lines.",
          findings: [
            {
              path: "src/example.ts",
              line: 99,
              severity: "medium",
              title: "Check this behavior",
              body: "This line is not part of the pull request diff.",
            },
          ],
        });

        expect(result).toMatchObject({
          submittedComments: 0,
          error: expect.stringContaining("at least one finding"),
        });
        expect(postedReviews).toHaveLength(0);
      }),
  );
});
