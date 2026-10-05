import { describe, expect, it } from "vite-plus/test";

import {
  buildGitHubPullRequestReviewPayload,
  getPullRequestAddedLineMap,
  parsePullRequestReviewOutput,
  validatePullRequestReviewFindings,
} from "./pullRequestReview.ts";

const patch = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1234567..abcdef0 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -8,3 +8,4 @@",
  " context line",
  "-removed line",
  "+added line one",
  "+added line two",
  " context line after",
  "\\ No newline at end of file",
  "diff --git a/deleted.ts b/deleted.ts",
  "--- a/deleted.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-removed",
].join("\n");

const finding = {
  path: "src/example.ts",
  line: 9,
  severity: "high" as const,
  title: "Handle missing input",
  body: "This path can receive an empty value and should be guarded.",
};

describe("pull request review output", () => {
  it("parses strict JSON output and a fenced JSON response", () => {
    const response = JSON.stringify({ summary: "Looks mostly good.", findings: [finding] });
    expect(parsePullRequestReviewOutput(response)).toEqual({
      summary: "Looks mostly good.",
      findings: [finding],
    });
    expect(parsePullRequestReviewOutput(`\`\`\`json\n${response}\n\`\`\``)).toEqual({
      summary: "Looks mostly good.",
      findings: [finding],
    });
  });

  it("infers a short finding title when model output omits it", () => {
    const parsed = parsePullRequestReviewOutput(
      JSON.stringify({
        summary: "One issue found.",
        findings: [
          {
            path: finding.path,
            line: finding.line,
            severity: finding.severity,
            body: "An empty response is not handled before indexing. This can crash the request.",
          },
        ],
      }),
    );

    expect(parsed.findings[0]?.title).toBe("An empty response is not handled before indexing");
  });

  it("normalizes finding arrays, JSON-encoded objects, and text-block wrappers", () => {
    const parsed = { summary: "Review findings are listed below.", findings: [finding] };
    expect(parsePullRequestReviewOutput(JSON.stringify([finding]))).toEqual(parsed);
    expect(parsePullRequestReviewOutput(JSON.stringify(JSON.stringify(parsed)))).toEqual(parsed);
    expect(
      parsePullRequestReviewOutput(
        JSON.stringify([{ type: "text", text: JSON.stringify(parsed) }]),
      ),
    ).toEqual(parsed);
    expect(parsePullRequestReviewOutput("[]")).toEqual({
      summary: "No actionable findings were returned.",
      findings: [],
    });
  });

  it("uses the unique diff-file path when model findings omit or mis-shape their path", () => {
    const responses = [
      { line: finding.line, body: finding.body, severity: finding.severity, title: finding.title },
      {
        path: { unexpected: true },
        line: finding.line,
        body: finding.body,
        severity: finding.severity,
        title: finding.title,
      },
      {
        path: { filePath: finding.path },
        line: finding.line,
        body: finding.body,
        severity: finding.severity,
        title: finding.title,
      },
    ];

    for (const item of responses) {
      expect(
        parsePullRequestReviewOutput(JSON.stringify({ summary: "Review", findings: [item] }), {
          pathFallback: finding.path,
        }).findings,
      ).toEqual([finding]);
    }
  });

  it("parses JSON embedded in explanatory text or a Markdown code block", () => {
    const response = JSON.stringify({
      summary: 'The review note includes braces: {"example": "value"}.',
      findings: [finding],
    });
    const parsed = {
      summary: 'The review note includes braces: {"example": "value"}.',
      findings: [finding],
    };

    expect(parsePullRequestReviewOutput(`Review result:\n${response}\nEnd of review.`)).toEqual(
      parsed,
    );
    expect(
      parsePullRequestReviewOutput(
        `Format note: {summary, findings}.\nReview result:\n${response}`,
      ),
    ).toEqual(parsed);
    expect(
      parsePullRequestReviewOutput(
        `Review result:\n\`\`\`json\n${response}\n\`\`\`\nEnd of review.`,
      ),
    ).toEqual(parsed);
  });

  it("normalizes structured summaries and supplies a safe fallback when missing", () => {
    expect(
      parsePullRequestReviewOutput(
        JSON.stringify({
          summary: [{ type: "text", text: "Review identified one issue." }],
          findings: [finding],
        }),
      ),
    ).toEqual({ summary: "Review identified one issue.", findings: [finding] });
    expect(
      parsePullRequestReviewOutput(
        JSON.stringify({ summary: { unexpected: true }, findings: [finding] }),
      ),
    ).toEqual({ summary: "Review findings are listed below.", findings: [finding] });
    expect(parsePullRequestReviewOutput(JSON.stringify({ findings: [] })).summary).toBe(
      "No actionable findings were returned.",
    );
  });

  it("normalizes single and JSON-encoded finding collections", () => {
    expect(
      parsePullRequestReviewOutput(JSON.stringify({ summary: "Review", findings: finding })),
    ).toEqual({ summary: "Review", findings: [finding] });
    expect(
      parsePullRequestReviewOutput(
        JSON.stringify({ summary: "Review", findings: JSON.stringify([finding]) }),
      ),
    ).toEqual({ summary: "Review", findings: [finding] });
  });

  it("normalizes common and unknown severity labels without dropping findings", () => {
    const response = (severity: unknown) =>
      parsePullRequestReviewOutput(
        JSON.stringify({ summary: "Review findings.", findings: [{ ...finding, severity }] }),
      ).findings[0]?.severity;

    expect(response("WARNING")).toBe("medium");
    expect(response("info")).toBe("low");
    expect(response("sev_2")).toBe("high");
    expect(response("unrecognized severity")).toBe("medium");
    expect(response(null)).toBe("medium");
  });

  it("rejects malformed model output and preserves every finding", () => {
    expect(() => parsePullRequestReviewOutput("not json")).toThrow(/valid JSON/);
    const parsed = parsePullRequestReviewOutput(
      JSON.stringify({ summary: "ok", findings: Array.from({ length: 31 }, () => finding) }),
    );
    expect(parsed.findings).toHaveLength(31);
    expect(parsed.summary).toBe("ok");
  });

  it("maps only added lines, not context or removed lines", () => {
    const lines = getPullRequestAddedLineMap(patch);
    expect([...(lines.get("src/example.ts") ?? [])]).toEqual([9, 10]);
    expect(lines.has("deleted.ts")).toBe(false);
  });

  it("counts added source lines that look like a new-file header", () => {
    const codeDiff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -0,0 +1 @@",
      "+++ export const marker = true;",
    ].join("\n");
    expect([...(getPullRequestAddedLineMap(codeDiff).get("file.ts") ?? [])]).toEqual([1]);
  });

  it("filters duplicate and non-added-line findings before submission", () => {
    expect(
      validatePullRequestReviewFindings(
        [finding, finding, { ...finding, line: 8 }, { ...finding, path: "deleted.ts", line: 1 }],
        patch,
      ),
    ).toEqual({ findings: [finding], skippedCount: 3 });
  });

  it("normalizes Git diff path prefixes before validating findings", () => {
    expect(
      validatePullRequestReviewFindings([{ ...finding, path: "b/src/example.ts" }], patch),
    ).toEqual({ findings: [finding], skippedCount: 0 });
  });

  it("builds a review payload tied to the head SHA and only current added lines", () => {
    expect(
      buildGitHubPullRequestReviewPayload({
        headSha: "a".repeat(40),
        summary: "Looks mostly good.",
        findings: [finding, { ...finding, line: 8 }],
        diff: patch,
      }),
    ).toEqual({
      payload: {
        commit_id: "a".repeat(40),
        event: "COMMENT",
        body: "Sparky AI code review\n\nLooks mostly good.\n\n_1 finding(s) were omitted because they did not match an added line in the current diff._",
        comments: [
          {
            path: "src/example.ts",
            line: 9,
            side: "RIGHT",
            body: "**HIGH: Handle missing input**\n\nThis path can receive an empty value and should be guarded.",
          },
        ],
      },
      submittedComments: 1,
      skippedComments: 1,
    });
    expect(() =>
      buildGitHubPullRequestReviewPayload({
        headSha: "a".repeat(40),
        summary: "Looks good.",
        findings: [{ ...finding, line: 8 }],
        diff: patch,
      }),
    ).toThrow(/at least one finding/);
    expect(() =>
      buildGitHubPullRequestReviewPayload({
        headSha: "not-a-sha",
        summary: "Looks good.",
        findings: [],
        diff: patch,
      }),
    ).toThrow(/head commit SHA/);
  });
});
