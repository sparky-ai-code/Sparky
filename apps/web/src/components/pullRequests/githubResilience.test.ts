import { describe, expect, it } from "vite-plus/test";

import {
  isGitHubAuthError,
  isTransientGitHubStatus,
  shouldApplyGitHubListResult,
} from "./githubResilience.ts";

describe("GitHub pull request refresh resilience", () => {
  it("never applies an errored list as an empty successful list", () => {
    expect(shouldApplyGitHubListResult(null)).toBe(true);
    expect(shouldApplyGitHubListResult("GitHub API 503: temporarily unavailable")).toBe(false);
  });

  it("does not turn rate limits and permissions into re-authentication", () => {
    expect(isGitHubAuthError("GitHub API 403: API rate limit exceeded")).toBe(false);
    expect(isGitHubAuthError("GitHub API 403: Resource not accessible by integration")).toBe(false);
    expect(isGitHubAuthError("GitHub API 401: Bad credentials")).toBe(true);
  });

  it("recognizes the status message used for a retained offline session", () => {
    expect(
      isTransientGitHubStatus("Could not reach GitHub. Your session was kept; try again later."),
    ).toBe(true);
  });
});
