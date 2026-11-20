import { describe, expect, it } from "vite-plus/test";

import {
  claudeAccountPlanLabel,
  claudeAccountStatusFromInfo,
  CLAUDE_SIGN_IN_COMMAND,
} from "./ClaudeAgentAccount.ts";
import {
  buildClaudeAgentChildEnvironment,
  isAcceptedClaudeAgentApiKeySource,
} from "./ClaudeAgentOptions.ts";

describe("claudeAccountPlanLabel", () => {
  it("names the plan from the CLI's subscription type", () => {
    expect(claudeAccountPlanLabel("max")).toBe("Max");
    expect(claudeAccountPlanLabel("claude_pro")).toBe("Pro");
    expect(claudeAccountPlanLabel("Team")).toBe("Team");
    expect(claudeAccountPlanLabel("enterprise")).toBe("Enterprise");
    expect(claudeAccountPlanLabel("")).toBeUndefined();
    expect(claudeAccountPlanLabel(undefined)).toBeUndefined();
  });

  it("title-cases an unknown plan name rather than dropping it", () => {
    expect(claudeAccountPlanLabel("beta")).toBe("Beta");
  });
});

describe("claudeAccountStatusFromInfo", () => {
  it("reports a signed-in account with its plan and email", () => {
    expect(
      claudeAccountStatusFromInfo({
        email: "me@example.com",
        subscriptionType: "max",
        apiKeySource: "none",
      }),
    ).toEqual({ signedIn: true, email: "me@example.com", plan: "Max" });
  });

  it("reports signed out with the sign-in command when no account is present", () => {
    const status = claudeAccountStatusFromInfo(undefined);
    expect(status.signedIn).toBe(false);
    expect(status.reason).toContain(CLAUDE_SIGN_IN_COMMAND);
    expect(claudeAccountStatusFromInfo({ apiKeySource: "none" }).signedIn).toBe(false);
  });
});

describe("claudeAccount auth mode", () => {
  it("accepts only the CLI's own sign-in source in account mode", () => {
    expect(isAcceptedClaudeAgentApiKeySource("none", "claudeAccount")).toBe(true);
    expect(isAcceptedClaudeAgentApiKeySource("ANTHROPIC_API_KEY", "claudeAccount")).toBe(false);
    expect(isAcceptedClaudeAgentApiKeySource("apiKeyHelper", "claudeAccount")).toBe(false);
    expect(isAcceptedClaudeAgentApiKeySource("oauth", "claudeAccount")).toBe(false);
  });

  it("builds an environment with no API key and no token variables in account mode", () => {
    const env = buildClaudeAgentChildEnvironment({
      environment: {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-should-not-pass",
        CLAUDE_CONFIG_DIR: "/home/me/.claude",
      },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/me/.claude");
    expect(env.PATH).toBe("/bin");
  });
});
