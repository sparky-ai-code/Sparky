import { PositiveInt, TrimmedNonEmptyString } from "@sparky/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

export const ReviewPullRequestTool = Tool.make("review_pull_request", {
  description:
    "Review a GitHub pull request with a separate one-shot review agent. The tool fetches the current PR metadata and diff, runs the configured independent reviewer, validates findings against added diff lines, and posts only actionable inline comments. If there are no actionable findings, it returns a clean result without creating an empty review. Call only when the user explicitly asks to review a pull request.",
  parameters: Schema.Struct({
    repository: TrimmedNonEmptyString,
    number: PositiveInt,
  }),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "Review pull request")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const PullRequestReviewToolkit = Toolkit.make(ReviewPullRequestTool);
