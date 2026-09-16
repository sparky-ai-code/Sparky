import { describe, expect, it } from "vite-plus/test";

import { isDefinitiveGitHubAuthFailure } from "./githubResilience.ts";

describe("GitHub credential failure classification", () => {
  it("recognizes an explicit invalid credential response", () => {
    expect(isDefinitiveGitHubAuthFailure(401, "GitHub API 401: Bad credentials")).toBe(true);
    expect(isDefinitiveGitHubAuthFailure(400, "invalid_grant")).toBe(true);
  });

  it("does not treat outages, rate limits, or permission errors as invalid credentials", () => {
    expect(isDefinitiveGitHubAuthFailure(null, "fetch failed")).toBe(false);
    expect(
      isDefinitiveGitHubAuthFailure(503, "GitHub authentication broker returned HTTP 503."),
    ).toBe(false);
    expect(isDefinitiveGitHubAuthFailure(403, "GitHub API 403: API rate limit exceeded")).toBe(
      false,
    );
    expect(
      isDefinitiveGitHubAuthFailure(403, "GitHub API 403: Resource not accessible by integration"),
    ).toBe(false);
  });
});
