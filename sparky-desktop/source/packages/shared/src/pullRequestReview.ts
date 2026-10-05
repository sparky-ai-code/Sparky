export type PullRequestReviewSeverity = "critical" | "high" | "medium" | "low";

export interface PullRequestReviewFinding {
  readonly path: string;
  readonly line: number;
  readonly severity: PullRequestReviewSeverity;
  readonly title: string;
  readonly body: string;
}

export interface PullRequestReviewOutput {
  readonly summary: string;
  readonly findings: ReadonlyArray<PullRequestReviewFinding>;
}

export interface ValidatedPullRequestReviewFindings {
  readonly findings: ReadonlyArray<PullRequestReviewFinding>;
  readonly skippedCount: number;
}

const MAX_SUMMARY_LENGTH = 8_000;
const MAX_TITLE_LENGTH = 200;
const MAX_FINDING_BODY_LENGTH = 5_000;

function fail(message: string): never {
  throw new Error(`Invalid AI pull request review: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireTrimmedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") fail(`${label} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    fail(`${label} must contain between 1 and ${maxLength} characters.`);
  }
  return trimmed;
}

export function normalizePullRequestReviewTitle(value: unknown, body: string): string {
  const supplied = typeof value === "string" ? value.trim() : "";
  const firstBodyLine = body
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|#{1,6}\s+|>\s*)/u, "").trim())
    .find(Boolean);
  const inferred = firstBodyLine
    ?.split(/[.!?](?:\s|$)/u, 1)[0]
    ?.replaceAll("**", "")
    .trim();
  return (supplied || inferred || "Review finding").slice(0, MAX_TITLE_LENGTH).trim();
}

function extractReviewSummaryText(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => extractReviewSummaryText(item, depth + 1))
      .filter((item): item is string => item !== null)
      .join("\n");
    return text || null;
  }
  if (!isRecord(value)) return null;

  for (const key of ["text", "content", "summary", "value"]) {
    if (key in value) {
      const text = extractReviewSummaryText(value[key], depth + 1);
      if (text) return text;
    }
  }
  return null;
}

function normalizeReviewSeverity(value: unknown): PullRequestReviewSeverity {
  if (typeof value !== "string") return "medium";
  const severity = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
  const aliases: Readonly<Record<string, PullRequestReviewSeverity>> = {
    critical: "critical",
    blocker: "critical",
    fatal: "critical",
    p0: "critical",
    "sev-0": "critical",
    "sev-1": "critical",
    high: "high",
    major: "high",
    error: "high",
    p1: "high",
    "sev-2": "high",
    medium: "medium",
    moderate: "medium",
    warning: "medium",
    warn: "medium",
    normal: "medium",
    p2: "medium",
    "sev-3": "medium",
    low: "low",
    minor: "low",
    info: "low",
    informational: "low",
    note: "low",
    suggestion: "low",
    nit: "low",
    p3: "low",
    "sev-4": "low",
  };
  return aliases[severity] ?? "medium";
}

function normalizeReviewSummary(value: unknown, findingCount: number): string {
  const extracted = extractReviewSummaryText(value);
  if (extracted && extracted.length <= MAX_SUMMARY_LENGTH) return extracted;
  return findingCount > 0
    ? "Review findings are listed below."
    : "No actionable findings were returned.";
}

function extractJsonObjects(value: string): ReadonlyArray<string> {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (start === -1) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        objects.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

const REVIEW_PATH_FIELDS = [
  "path",
  "filePath",
  "file_path",
  "fileName",
  "file_name",
  "relativePath",
  "relative_path",
  "file",
  "filename",
] as const;

function extractReviewPath(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const segments = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return segments.length > 0 ? segments.join("/") : undefined;
  }
  if (!isRecord(value)) return undefined;

  for (const key of REVIEW_PATH_FIELDS) {
    if (key in value) {
      const path = extractReviewPath(value[key], depth + 1);
      if (path) return path;
    }
  }
  for (const key of ["value", "text"] as const) {
    if (key in value) {
      const path = extractReviewPath(value[key], depth + 1);
      if (path) return path;
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (/(?:path|file|filename)/iu.test(key)) {
      const path = extractReviewPath(item, depth + 1);
      if (path) return path;
    }
  }
  return undefined;
}

function normalizeFindingRecord(
  value: unknown,
  pathFallback?: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  const path =
    REVIEW_PATH_FIELDS.map((key) => extractReviewPath(value[key])).find(
      (candidate): candidate is string => candidate !== undefined,
    ) ??
    entries.find(
      ([key, item]) => typeof item === "string" && /(?:path|file|filename)/iu.test(key),
    )?.[1] ??
    pathFallback;
  const rawLine =
    value.line ??
    value.lineNumber ??
    value.line_number ??
    value.startLine ??
    value.start_line ??
    value.newLine ??
    value.new_line ??
    entries.find(([key, item]) => typeof item === "number" && /line|position/iu.test(key))?.[1];
  const location = typeof path === "string" ? path.match(/^(.*?)(?::(\d+))$/u) : null;
  const normalizedPath = location?.[1] ?? path;
  const normalizedLine =
    typeof rawLine === "number"
      ? rawLine
      : typeof rawLine === "string" && /^\d+$/u.test(rawLine)
        ? Number(rawLine)
        : location?.[2] === undefined
          ? undefined
          : Number(location[2]);
  const body =
    value.body ??
    value.description ??
    value.reviewComment ??
    value.review_comment ??
    value.comment ??
    value.message ??
    value.explanation ??
    value.details ??
    value.impact ??
    value.reason ??
    value.recommendation ??
    value.suggestion ??
    value.issue ??
    entries.find(
      ([key, item]) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        !/(?:path|file|line|position|severity|title)/iu.test(key),
    )?.[1];
  if (normalizedPath === undefined || normalizedLine === undefined || body === undefined)
    return null;
  return {
    ...value,
    path: normalizedPath,
    line: normalizedLine,
    body,
  };
}

function isFindingShape(value: unknown): value is Record<string, unknown> {
  return normalizeFindingRecord(value) !== null;
}

function normalizeFindingCollection(
  value: unknown,
  depth = 0,
  pathFallback?: string,
): ReadonlyArray<unknown> | null {
  if (depth > 8) return null;
  if (typeof value === "string") {
    const text = value
      .trim()
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "");
    try {
      return normalizeFindingCollection(JSON.parse(text), depth + 1, pathFallback);
    } catch {
      for (const object of extractJsonObjects(text)) {
        try {
          const findings = normalizeFindingCollection(JSON.parse(object), depth + 1, pathFallback);
          if (findings) return findings;
        } catch {
          // Skip unrelated JSON objects in explanatory text.
        }
      }
      return null;
    }
  }
  if (Array.isArray(value)) {
    const findings: unknown[] = [];
    for (const item of value) {
      const normalized = normalizeFindingRecord(item, pathFallback);
      if (normalized) {
        findings.push(normalized);
        continue;
      }
      if (isRecord(item) || typeof item === "string") {
        const nested = normalizeFindingCollection(item, depth + 1, pathFallback);
        if (nested) {
          findings.push(...nested);
          continue;
        }
      }
      findings.push(item);
    }
    return findings;
  }
  const finding = normalizeFindingRecord(value, pathFallback);
  if (finding) return [finding];
  if (isRecord(value)) {
    const collectionKeys = [
      "findings",
      "finding",
      "reviewFindings",
      "review_findings",
      "items",
      "results",
      "comments",
      "inlineComments",
      "inline_comments",
      "annotations",
      "issues",
      "review",
      "value",
      "content",
      "text",
      "output",
      "response",
      "data",
      "message",
    ];
    for (const key of collectionKeys) {
      if (key in value) {
        const nested = normalizeFindingCollection(value[key], depth + 1, pathFallback);
        if (nested) return nested;
      }
    }
    for (const [key, candidate] of Object.entries(value)) {
      if (isRecord(candidate)) {
        const keyPathFallback = /[/\\]|\.[a-z0-9]+$/iu.test(key) ? key : undefined;
        const keyedFinding = normalizeFindingRecord(candidate, keyPathFallback ?? pathFallback);
        if (keyedFinding) return [keyedFinding];
      }
      if (Array.isArray(candidate) || isRecord(candidate) || typeof candidate === "string") {
        const nested = normalizeFindingCollection(candidate, depth + 1, pathFallback);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function normalizeDecodedReview(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === "string") {
    try {
      return normalizeDecodedReview(JSON.parse(value), depth + 1);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.every(isFindingShape)) return { findings: value };
    const textParts = value
      .map((item) => (typeof item === "string" ? item : extractReviewSummaryText(item)))
      .filter((item): item is string => item !== null);
    if (textParts.length === value.length && textParts.length > 0) {
      const text = textParts.join("\n").trim();
      try {
        return normalizeDecodedReview(JSON.parse(text), depth + 1);
      } catch {
        return { summary: text, findings: [] };
      }
    }
    return { findings: value };
  }
  if (!isRecord(value) || "summary" in value || "findings" in value) return value;

  for (const key of ["output", "result", "response", "content", "data", "message"]) {
    if (key in value) return normalizeDecodedReview(value[key], depth + 1);
  }
  return value;
}

function parsePlainTextReviewOutput(raw: string): PullRequestReviewOutput {
  const anchors: Array<{ readonly index: number; readonly path: string; readonly line: number }> =
    [];
  const fileThenLine =
    /(?:^|[\s`"'(])((?:[a-z0-9_.@-]+[\\/])+[a-z0-9_.@-]+|[a-z0-9_.@-]+\.[a-z0-9]+)(?:`)?\s*(?::\s*|#L|(?:,\s*)?line\s*[:#]?\s*|\(\s*line\s+)(\d+)\)?/giu;
  const lineThenFile =
    /\bline\s+(\d+)\s+(?:in|at)\s+[`"']?((?:[a-z0-9_.@-]+[\\/])+[a-z0-9_.@-]+|[a-z0-9_.@-]+\.[a-z0-9]+)/giu;
  for (const match of raw.matchAll(fileThenLine)) {
    const path = match[1]?.replaceAll("\\", "/");
    const line = Number(match[2]);
    if (path && Number.isSafeInteger(line) && line > 0) {
      anchors.push({ index: match.index ?? 0, path, line });
    }
  }
  for (const match of raw.matchAll(lineThenFile)) {
    const path = match[2]?.replaceAll("\\", "/");
    const line = Number(match[1]);
    if (path && Number.isSafeInteger(line) && line > 0) {
      anchors.push({ index: match.index ?? 0, path, line });
    }
  }
  anchors.sort((left, right) => left.index - right.index);
  const uniqueAnchors = anchors.filter(
    (anchor, index) =>
      anchors.findIndex(
        (candidate) =>
          candidate.path === anchor.path &&
          candidate.line === anchor.line &&
          Math.abs(candidate.index - anchor.index) < 8,
      ) === index,
  );
  if (uniqueAnchors.length === 0) {
    return fail("response must be valid JSON or include exact file-and-line anchors.");
  }
  const findings = uniqueAnchors.map((anchor, index): PullRequestReviewFinding => {
    const nextAnchor = uniqueAnchors[index + 1]?.index ?? raw.length;
    const previousParagraph = raw.lastIndexOf("\n\n", Math.max(0, anchor.index - 1));
    const paragraphStart = previousParagraph < 0 ? 0 : previousParagraph + 2;
    const nextParagraph = raw.indexOf("\n\n", anchor.index);
    const paragraphEnd = nextParagraph < 0 ? raw.length : Math.min(nextParagraph, nextAnchor);
    const content = raw.slice(paragraphStart, paragraphEnd);
    const cleaned = content
      .replace(fileThenLine, " ")
      .replace(lineThenFile, " ")
      .split(/\r?\n/u)
      .map((line) =>
        line
          .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/u, "")
          .replace(/[*`_]/gu, "")
          .trim(),
      )
      .filter((line) => line && !/^summary\s*:/iu.test(line))
      .join("\n")
      .trim();
    const firstLine = cleaned.split(/\r?\n/u).find(Boolean) ?? "Review finding";
    const severity = cleaned.match(
      /\b(critical|blocker|high|major|medium|moderate|low|minor|p[0-3])\b/iu,
    )?.[1];
    const body = (cleaned || firstLine).slice(0, MAX_FINDING_BODY_LENGTH);
    return {
      path: anchor.path,
      line: anchor.line,
      severity: normalizeReviewSeverity(severity),
      title: normalizePullRequestReviewTitle(firstLine, body),
      body,
    };
  });
  const summaryText = raw.slice(0, uniqueAnchors[0]?.index ?? raw.length).trim();
  const summary = normalizeReviewSummary(
    /^review\s+findings:?$/iu.test(summaryText) ? undefined : summaryText,
    findings.length,
  );
  return { summary, findings };
}

export function parsePullRequestReviewOutput(
  raw: string,
  options: { readonly pathFallback?: string } = {},
): PullRequestReviewOutput {
  const trimmed = raw.trim().replace(/^\uFEFF/u, "");
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  const candidates = [
    ...new Set([fenced, trimmed].filter((value): value is string => Boolean(value))),
  ];
  let decoded: unknown;
  let parsed = false;

  for (const candidate of candidates) {
    try {
      decoded = JSON.parse(candidate);
      parsed = true;
      break;
    } catch {
      let fallback: unknown;
      let hasFallback = false;
      for (const object of extractJsonObjects(candidate)) {
        try {
          const objectValue: unknown = JSON.parse(object);
          if (isRecord(objectValue) && "summary" in objectValue && "findings" in objectValue) {
            decoded = objectValue;
            parsed = true;
            break;
          }
          if (!hasFallback) {
            fallback = objectValue;
            hasFallback = true;
          }
        } catch {
          // Ignore non-JSON braces in explanatory text.
        }
      }
      if (!parsed && hasFallback) {
        decoded = fallback;
        parsed = true;
      }
      if (parsed) break;
    }
  }

  if (!parsed) return parsePlainTextReviewOutput(trimmed);

  decoded = normalizeDecodedReview(decoded);
  if (!isRecord(decoded)) return fail("response must be a JSON object.");
  const findingSource =
    decoded.findings ??
    decoded.finding ??
    decoded.reviewFindings ??
    decoded.review_findings ??
    decoded.issues ??
    decoded.comments ??
    decoded.inlineComments ??
    decoded.inline_comments ??
    decoded.annotations ??
    decoded.results ??
    decoded.items;
  const normalizedFindings =
    normalizeFindingCollection(findingSource, 0, options.pathFallback) ??
    normalizeFindingCollection(decoded, 0, options.pathFallback);
  if (!normalizedFindings) {
    return fail("the model response did not contain readable review findings.");
  }
  const findings = normalizedFindings.map((value, index): PullRequestReviewFinding => {
    if (!isRecord(value)) return fail(`finding ${index + 1} must be an object.`);
    const path = requireTrimmedString(value.path, `finding ${index + 1} path`, 1_000);
    if (typeof value.line !== "number" || !Number.isSafeInteger(value.line) || value.line < 1) {
      return fail(`finding ${index + 1} line must be a positive integer.`);
    }
    const body = requireTrimmedString(
      value.body,
      `finding ${index + 1} body`,
      MAX_FINDING_BODY_LENGTH,
    );
    return {
      path,
      line: value.line,
      severity: normalizeReviewSeverity(value.severity),
      title: normalizePullRequestReviewTitle(value.title, body),
      body,
    };
  });

  const summary = normalizeReviewSummary(decoded.summary, findings.length);
  return { summary, findings };
}

function decodeDiffPath(value: string): string | null {
  let path = value.trim();
  if (path.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(path);
      if (typeof decoded !== "string") return null;
      path = decoded;
    } catch {
      return null;
    }
  }
  if (path === "/dev/null") return null;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === ".." || segment.length === 0)
  ) {
    return null;
  }
  return path;
}

function parseDiffPathLine(line: string): string | null {
  const value = line.slice(4);
  if (value.startsWith('"')) {
    const closingQuote = value.lastIndexOf('"');
    if (closingQuote <= 0) return null;
    return decodeDiffPath(value.slice(0, closingQuote + 1));
  }
  return decodeDiffPath(value.split("\t", 1)[0] ?? "");
}

/** Return newly-added line numbers keyed by repository-relative patch path. */
export function getPullRequestAddedLineMap(diff: string): ReadonlyMap<string, ReadonlySet<number>> {
  const addedLines = new Map<string, Set<number>>();
  const lines = diff.split(/\r?\n/);
  let currentPath: string | null = null;
  let newLine: number | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      newLine = null;
      continue;
    }
    if (newLine === null && line.startsWith("+++ ")) {
      currentPath = parseDiffPathLine(line);
      newLine = null;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (newLine === null || currentPath === null || line.startsWith("\\")) continue;

    if (line.startsWith("+")) {
      const fileLines = addedLines.get(currentPath) ?? new Set<number>();
      fileLines.add(newLine);
      addedLines.set(currentPath, fileLines);
      newLine += 1;
    } else if (line.startsWith(" ")) {
      newLine += 1;
    } else if (line.startsWith("-")) {
      // Removed lines only advance the old-file cursor, not the new-file cursor.
    } else if (line.startsWith("diff --git ")) {
      currentPath = null;
      newLine = null;
    }
  }

  return addedLines;
}

/** Keep only unique findings anchored to lines actually added by this PR diff. */
export function validatePullRequestReviewFindings(
  findings: ReadonlyArray<PullRequestReviewFinding>,
  diff: string,
): ValidatedPullRequestReviewFindings {
  const addedLines = getPullRequestAddedLineMap(diff);
  const seen = new Set<string>();
  const valid: PullRequestReviewFinding[] = [];
  let skippedCount = 0;

  for (const finding of findings) {
    const candidatePaths = [
      finding.path,
      ...(finding.path.startsWith("a/") || finding.path.startsWith("b/")
        ? [finding.path.slice(2)]
        : []),
    ];
    const matchedPath = candidatePaths.find((path) => addedLines.get(path)?.has(finding.line));
    const key = matchedPath ? `${matchedPath}\0${finding.line}` : null;
    if (!matchedPath || !key || seen.has(key)) {
      skippedCount += 1;
      continue;
    }
    seen.add(key);
    valid.push(matchedPath === finding.path ? finding : { ...finding, path: matchedPath });
  }

  return { findings: valid, skippedCount };
}

export interface GitHubPullRequestReviewPayload {
  readonly commit_id: string;
  readonly event: "COMMENT";
  readonly body: string;
  readonly comments: ReadonlyArray<{
    readonly path: string;
    readonly line: number;
    readonly side: "RIGHT";
    readonly body: string;
  }>;
}

export interface BuiltGitHubPullRequestReviewPayload {
  readonly payload: GitHubPullRequestReviewPayload;
  readonly submittedComments: number;
  readonly skippedComments: number;
}

/** Build the GitHub review body and only include comments on current added lines. */
export function buildGitHubPullRequestReviewPayload(input: {
  readonly headSha: string;
  readonly summary: string;
  readonly findings: ReadonlyArray<PullRequestReviewFinding>;
  readonly diff: string;
}): BuiltGitHubPullRequestReviewPayload {
  if (!/^[a-f0-9]{40,64}$/i.test(input.headSha)) fail("head commit SHA is invalid.");
  const summary = requireTrimmedString(input.summary, "summary", MAX_SUMMARY_LENGTH);
  const validated = validatePullRequestReviewFindings(input.findings, input.diff);
  if (validated.findings.length === 0) {
    fail("at least one finding must match an added line before a review can be posted.");
  }
  const body = [
    "Sparky AI code review",
    "",
    summary,
    ...(validated.skippedCount > 0
      ? [
          "",
          `_${validated.skippedCount} finding(s) were omitted because they did not match an added line in the current diff._`,
        ]
      : []),
  ].join("\n");

  return {
    payload: {
      commit_id: input.headSha,
      event: "COMMENT",
      body,
      comments: validated.findings.map((finding) => ({
        path: finding.path,
        line: finding.line,
        side: "RIGHT" as const,
        body: `**${finding.severity.toUpperCase()}: ${finding.title}**\n\n${finding.body}`,
      })),
    },
    submittedComments: validated.findings.length,
    skippedComments: validated.skippedCount,
  };
}
