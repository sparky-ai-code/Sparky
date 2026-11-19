---
name: pr-review-high-detail
description: Perform a thorough, evidence-based code review of a pull request or proposed diff. Trace changed behavior through callers, data contracts, failure paths, security boundaries, tests, and platform/build implications; report only actionable findings with precise locations. Use when the user asks for a detailed, deep, or high-confidence PR/code review.
---

# High-detail Pull Request Review

Review for defects introduced by the change, not for stylistic preference. Be thorough in investigation and concise in findings. Do not modify code, commit, push, or publish review comments unless the user explicitly asks for that action.

## 1. Establish review scope

- Confirm the repository, target PR/branch, base branch, and exact diff under review. If the target or base is ambiguous and would materially change the review, ask one focused question.
- Read applicable `AGENTS.md` instructions, repository conventions, and relevant package documentation before evaluating code.
- Check the worktree for unrelated local modifications. Preserve them; do not reset, clean, stash, or overwrite user changes.
- Define the changed-file set from the diff. Include renames, generated/configuration changes, migrations, and test changes; do not assume the visible patch is the full behavior change.
- For a GitHub pull request explicitly requested for review, use the configured dedicated PR-review tool when available and follow its contract. Do not independently fetch/review the same PR diff or post separate comments. Otherwise, inspect the local diff and codebase with repository tools.

## 2. Build a behavior map before judging

For each changed production path:

1. Identify the externally observable behavior, inputs, outputs, state changes, and side effects.
2. Trace the code both upstream and downstream: callers, implementations, event handlers, persistence, serialization, API/schema contracts, UI consumers, and cleanup/lifecycle paths.
3. Compare changed behavior with the old behavior and with adjacent implementations. Check whether all call sites and platform variants were updated consistently.
4. Follow data across trust boundaries and asynchronous boundaries. Verify validation, authorization, ownership, cancellation, retries, timeouts, idempotency, and error propagation where relevant.
5. Inspect tests and fixtures to learn intended invariants, but treat tests as evidence—not proof that the implementation is correct.

Do not review a changed line in isolation when its correctness depends on a caller, contract, resource lifecycle, persisted state, or build/runtime packaging.

## 3. Review systematically

Use the applicable categories; spend effort proportional to risk and change scope.

### Correctness and edge cases

- Check normal, boundary, empty, malformed, duplicate, stale, partial, and concurrent inputs as relevant.
- Look for incorrect conditions, inverted branches, state transitions, stale closures, race conditions, missed cleanup, unexpected fallbacks, and behavior that differs between first use and subsequent use.
- Verify that retries are bounded and appropriate, and that failures remain visible rather than being silently swallowed.
- Check resource ownership and release: processes, subscriptions, timers, streams, locks, files, database transactions, and temporary state.

### Contracts and compatibility

- Trace API, IPC, wire, schema, database, configuration, command-line, and file-format changes across producers and consumers.
- Check backward/forward compatibility, migration and rollback behavior, defaults, nullability, enum exhaustiveness, and version/platform conditions.
- Verify public names, paths, packaging assumptions, and legacy compatibility contracts remain intact unless the change explicitly migrates them.

### Security and privacy

- Examine authorization and tenant/user boundaries, untrusted input handling, path/command construction, injection risks, secrets, sensitive logging, unsafe deserialization, and accidental data disclosure.
- For filesystem/process/network operations, verify path containment, argument escaping, allowed destinations, and safe failure behavior.
- Do not reproduce or expose secret values in review output.

### Reliability and performance

- Check unbounded work, repeated expensive operations, memory/resource growth, blocking work on interactive paths, N+1 access, large payloads, and failure behavior during outages or restarts.
- For distributed or async flows, inspect ordering, duplicate delivery, reconnect/resume, cancellation, backpressure, and partial completion.

### Tests and operational impact

- Determine whether tests cover the changed invariant and relevant regressions, not merely the happy path.
- Look for tests that assert implementation details, miss error paths, or use fixtures that cannot represent real state.
- Check whether config, migrations, build scripts, release packaging, platform-specific behavior, and deployment/rollback need coordinated updates.
- Run focused read-only checks or tests only when safe and useful. Do not run destructive migrations, production actions, or broad commands with side effects. Report checks actually run and their exact outcomes.

## 4. Validate each candidate finding

Before reporting a finding:

- Establish a concrete triggering scenario and trace it to a user-visible failure, data loss/corruption, security issue, crash, compatibility break, or meaningful operational problem.
- Confirm the defect is introduced by this diff, not pre-existing behavior or a hypothetical future concern.
- Check whether an existing guard, caller invariant, transaction, cleanup path, or test already prevents it.
- Make the smallest claim supported by evidence. Do not infer behavior from names or comments when source behavior can be traced.
- Attach the finding to the narrowest changed line that causes the issue. The location must overlap the diff when reporting inline PR feedback.
- If a candidate cannot be confirmed, do not present it as a bug. Mention uncertainty only in a clearly separate, non-blocking note when it materially affects confidence.

## 5. Write actionable findings

Order confirmed findings by severity, then by impact. For each finding include:

- **Severity:** Critical / High / Medium / Low, using the repository or review tool's supported scale when one exists.
- **Location:** file and exact changed line(s), or an equivalent precise reference.
- **Issue:** the specific defect, without vague language.
- **Trigger and impact:** the realistic conditions under which it occurs and the resulting consequence.
- **Reasoning:** concise evidence from the relevant control/data flow.
- **Direction:** a minimal corrective direction where it helps; do not prescribe a broad rewrite.

Prefer one finding per root cause. Avoid duplicate comments across the same issue. Do not report formatting preferences, speculative risks, missing tests alone, or suggestions disguised as bugs. A missing test is worth reporting only when it leaves a concrete regression risk that is itself actionable.

## 6. Final response

- Lead with actionable findings, most severe first. If none are confirmed, say clearly that no actionable defects were found; do not invent findings to make the review look thorough.
- Summarize the main areas traced and list verification performed, distinguishing passed, failed, and not run checks.
- State any material scope limitation (for example, unavailable service, inaccessible dependency, or untested platform). Do not claim broader verification than was performed.
- Keep optional suggestions and open questions separate from defects. Do not claim comments were posted unless the review tool confirms that they were.
