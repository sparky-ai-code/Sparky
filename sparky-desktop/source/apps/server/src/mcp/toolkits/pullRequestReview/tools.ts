import {
  ModelSelection,
  PositiveInt,
  PullRequestReviewEffort,
  PullRequestReviewFocus,
  TrimmedNonEmptyString,
} from "@sparky/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

export const ReviewPullRequestTool = Tool.make("review_pull_request", {
  description:
    "Review a GitHub pull request with Sparky's isolated, server-owned bug-review pipeline. The tool fetches the current PR metadata and diff, chunks large diffs, validates all model findings against added lines, and posts only actionable inline comments. Optionally supply the model, focus, and effort from review settings; otherwise use the configured text-generation model with default focus and effort. A clean result requires a valid explicit findings array. Call only when the user explicitly asks to review a pull request.",
  parameters: Schema.Struct({
    repository: TrimmedNonEmptyString,
    number: PositiveInt,
    modelSelection: Schema.optionalKey(ModelSelection),
    focus: Schema.optionalKey(PullRequestReviewFocus),
    effort: Schema.optionalKey(PullRequestReviewEffort),
  }),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "Review pull request")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const PullRequestReviewToolkit = Toolkit.make(ReviewPullRequestTool);
