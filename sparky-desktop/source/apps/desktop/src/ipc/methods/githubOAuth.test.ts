import { describe, expect, it } from "vite-plus/test";

import { GITHUB_OAUTH_SCOPE, githubUserRepositoriesPath } from "./githubOAuth.ts";

describe("GitHub OAuth repository access", () => {
  it("uses the OAuth user repositories endpoint instead of GitHub App installations", () => {
    const path = githubUserRepositoriesPath(1);

    expect(path).toContain("/user/repos?");
    expect(path).not.toContain("installations");
    expect(path).toContain("visibility=all");
    expect(path).toContain("affiliation=owner%2Ccollaborator%2Corganization_member");
  });

  it("requests the scope required to list private repositories", () => {
    expect(GITHUB_OAUTH_SCOPE).toBe("repo");
  });
});
