import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_PULL_REQUEST_REVIEW_EFFORT,
  DEFAULT_PULL_REQUEST_REVIEW_FOCUS,
  type GitPullRequestReviewInput,
} from "@sparky/contracts";
import { buildGitHubPullRequestReviewPayload } from "@sparky/shared/pullRequestReview";
import * as ProcessRunner from "../../../processRunner.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

class PullRequestReviewToolError extends Schema.TaggedErrorClass<PullRequestReviewToolError>()(
  "PullRequestReviewToolError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

function parseJson(
  raw: string,
  detail: string,
): Effect.Effect<Record<string, unknown>, PullRequestReviewToolError> {
  return Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(raw).pipe(
    Effect.mapError(() => new PullRequestReviewToolError({ detail })),
    Effect.flatMap((value) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Effect.succeed(value as Record<string, unknown>)
        : Effect.fail(new PullRequestReviewToolError({ detail })),
    ),
  );
}

function validateRepository(repository: string): boolean {
  const [owner, name, ...extra] = repository.trim().split("/");
  const validPart = (value: string | undefined) =>
    value !== undefined && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/u.test(value);
  return extra.length === 0 && validPart(owner) && validPart(name);
}

function getHeadSha(value: Record<string, unknown>): string | null {
  return typeof value.headRefOid === "string" && /^[a-f0-9]{40,64}$/iu.test(value.headRefOid)
    ? value.headRefOid
    : null;
}

export const reviewPullRequest = (
  processRunner: ProcessRunner.ProcessRunner["Service"],
  gitWorkflow: GitWorkflowService.GitWorkflowService["Service"],
  serverSettings: ServerSettings.ServerSettingsService["Service"],
  invocation: McpInvocationContext.McpInvocationScope,
  input: { readonly repository: string; readonly number: number } & Partial<
    Pick<GitPullRequestReviewInput, "modelSelection" | "focus" | "effort">
  >,
) =>
  Effect.gen(function* () {
    const cwd = invocation.cwd;
    if (!cwd) return { error: "This review tool requires an active project workspace." };
    if (!validateRepository(input.repository)) {
      return { error: "repository must be an exact owner/repository name." };
    }

    const runGh = (args: ReadonlyArray<string>, stdin?: string, maxOutputBytes = 100_000) =>
      processRunner
        .run({
          command: "gh",
          args,
          cwd,
          ...(stdin !== undefined ? { stdin } : {}),
          timeout: "120 seconds",
          maxOutputBytes,
          outputMode: "truncate",
          truncatedMarker: "",
          timeoutBehavior: "error",
        })
        .pipe(
          Effect.flatMap((result) =>
            result.code === 0
              ? Effect.succeed(result)
              : Effect.fail(
                  new PullRequestReviewToolError({
                    detail:
                      result.stderr.trim() ||
                      `gh ${args[0] ?? "command"} failed with exit code ${result.code}`,
                  }),
                ),
          ),
        );
    const commonArgs = ["--repo", input.repository];
    const prViewArgs = [
      "pr",
      "view",
      String(input.number),
      ...commonArgs,
      "--json",
      "number,url,title,body,baseRefName,headRefName,headRefOid",
    ];
    const prView = yield* runGh(prViewArgs);
    if (prView.stdoutTruncated) return { error: "GitHub CLI truncated the pull request metadata." };
    const pullRequest = yield* parseJson(
      prView.stdout,
      "GitHub CLI returned invalid pull request metadata.",
    );
    if (
      pullRequest.number !== input.number ||
      typeof pullRequest.url !== "string" ||
      typeof pullRequest.title !== "string"
    ) {
      return { error: "GitHub CLI returned incomplete metadata for the pull request." };
    }
    const headSha = getHeadSha(pullRequest);
    if (!headSha) return { error: "GitHub CLI did not return a valid pull request head SHA." };

    const diffResult = yield* runGh(
      ["pr", "diff", String(input.number), ...commonArgs],
      undefined,
      1_000_000,
    );
    if (diffResult.stdoutTruncated) {
      return { error: "The pull request diff is too large to review safely." };
    }
    const settings = yield* serverSettings.getSettings;
    const aiReview = yield* gitWorkflow.reviewPullRequest({
      cwd,
      // Desktop preferences stay client-local and are sent explicitly by the page. MCP callers can override them.
      modelSelection: input.modelSelection ?? settings.textGenerationModelSelection,
      focus: input.focus ?? DEFAULT_PULL_REQUEST_REVIEW_FOCUS,
      effort: input.effort ?? DEFAULT_PULL_REQUEST_REVIEW_EFFORT,
      context: {
        title: pullRequest.title,
        body: typeof pullRequest.body === "string" ? pullRequest.body : null,
        url: pullRequest.url,
        baseBranch: typeof pullRequest.baseRefName === "string" ? pullRequest.baseRefName : "",
        headBranch: typeof pullRequest.headRefName === "string" ? pullRequest.headRefName : "",
        diff: diffResult.stdout,
      },
    });

    const latestView = yield* runGh(prViewArgs);
    if (latestView.stdoutTruncated) {
      return { error: "GitHub CLI truncated the pull request metadata." };
    }
    const latestPr = yield* parseJson(
      latestView.stdout,
      "GitHub CLI returned invalid pull request metadata.",
    );
    if (getHeadSha(latestPr)?.toLowerCase() !== headSha.toLowerCase()) {
      return { error: "The pull request changed during review. Refresh the diff and retry." };
    }

    if (aiReview.findings.length === 0) {
      return {
        repository: input.repository,
        number: input.number,
        pullRequestUrl: pullRequest.url,
        headSha,
        summary: aiReview.report,
        findings: [],
        submittedComments: 0,
        skippedComments: aiReview.skippedFindings,
        reviewUrl: null,
        error: null,
      };
    }

    const review = yield* Effect.try({
      try: () =>
        buildGitHubPullRequestReviewPayload({
          headSha,
          summary: aiReview.summary,
          findings: aiReview.findings,
          diff: diffResult.stdout,
        }),
      catch: (cause) =>
        new PullRequestReviewToolError({
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    const reviewJson = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(
      review.payload,
    );
    const posted = yield* runGh(
      [
        "api",
        "--method",
        "POST",
        `repos/${input.repository}/pulls/${input.number}/reviews`,
        "--input",
        "-",
      ],
      reviewJson,
    ).pipe(
      Effect.map((result) => ({ result, error: null })),
      Effect.catch((cause) =>
        Effect.succeed({
          result: null,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    );
    if (!posted.result) {
      return {
        repository: input.repository,
        number: input.number,
        headSha,
        summary: aiReview.report,
        findings: aiReview.findings,
        submittedComments: 0,
        skippedComments: aiReview.skippedFindings,
        reviewUrl: null,
        error: `Review complete, but GitHub did not confirm posting: ${posted.error}`,
      };
    }
    const postedReview = yield* parseJson(
      posted.result.stdout,
      "GitHub CLI returned invalid review response data.",
    );

    return {
      repository: input.repository,
      number: input.number,
      pullRequestUrl: pullRequest.url,
      reviewUrl: typeof postedReview.html_url === "string" ? postedReview.html_url : null,
      headSha,
      summary: aiReview.report,
      findings: aiReview.findings,
      comments: review.payload.comments,
      submittedComments: review.submittedComments,
      skippedComments: aiReview.skippedFindings + review.skippedComments,
      error: null,
    };
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({ error: cause instanceof Error ? cause.message : String(cause) }),
    ),
  );
