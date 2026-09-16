import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
} from "./providerSkillPresentation";

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("formatProviderSkillInstallSource", () => {
  it("maps standard scopes to user-facing labels", () => {
    expect(
      formatProviderSkillInstallSource({
        scope: "user",
      }),
    ).toBe("Personal");
    expect(
      formatProviderSkillInstallSource({
        scope: "system",
      }),
    ).toBe("System");
    expect(
      formatProviderSkillInstallSource({
        scope: "project",
      }),
    ).toBe("Project");
  });
});
