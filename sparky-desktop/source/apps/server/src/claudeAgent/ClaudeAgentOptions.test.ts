import { describe, expect, it } from "vite-plus/test";

import {
  buildClaudeAgentChildEnvironment,
  buildClaudeAgentOptions,
  isAcceptedClaudeAgentApiKeySource,
  resolveClaudeAgentApiKey,
  sparkyMcpToolPattern,
} from "./ClaudeAgentOptions.ts";

describe("resolveClaudeAgentApiKey", () => {
  it("accepts only an API key from the environment", () => {
    expect(resolveClaudeAgentApiKey({ ANTHROPIC_API_KEY: "  sk-ant-api-test  " })).toEqual({
      ok: true,
      apiKey: "sk-ant-api-test",
    });
  });

  it("refuses to run without an API key, even if an OAuth token exists", () => {
    const result = resolveClaudeAgentApiKey({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ANTHROPIC_API_KEY");
  });
});

describe("buildClaudeAgentChildEnvironment", () => {
  it("strips subscription and OAuth credentials and sets the API key", () => {
    const env = buildClaudeAgentChildEnvironment({
      environment: {
        PATH: "/usr/bin",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "refresh-token",
        CLAUDE_CODE_API_KEY_HELPER: "helper",
        ANTHROPIC_AUTH_TOKEN: "bearer",
        UNRELATED_SECRET: "do-not-forward",
        ANTHROPIC_API_KEY: "ignored-in-favor-of-explicit-key",
      },
      apiKey: "sk-ant-api-test",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api-test");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_API_KEY_HELPER).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });

  it("does not let extra variables reintroduce subscription credentials", () => {
    const env = buildClaudeAgentChildEnvironment({
      environment: {},
      apiKey: "sk-ant-api-test",
      extra: { CLAUDE_CODE_OAUTH_TOKEN: "sneaky", CUSTOM_FLAG: "1" },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CUSTOM_FLAG).toBe("1");
  });
});

describe("isAcceptedClaudeAgentApiKeySource", () => {
  it("accepts only the Console API key source", () => {
    expect(isAcceptedClaudeAgentApiKeySource("ANTHROPIC_API_KEY")).toBe(true);
    expect(isAcceptedClaudeAgentApiKeySource("none")).toBe(false);
    expect(isAcceptedClaudeAgentApiKeySource("oauth")).toBe(false);
    expect(isAcceptedClaudeAgentApiKeySource("apiKeyHelper")).toBe(false);
    expect(isAcceptedClaudeAgentApiKeySource("/login managed key")).toBe(false);
    expect(isAcceptedClaudeAgentApiKeySource(undefined)).toBe(false);
  });
});

describe("buildClaudeAgentOptions", () => {
  const canUseTool = async () => ({ behavior: "allow" as const, updatedInput: {} });

  it("wires the Sparky MCP bridge, pre-approves only Sparky tools, and loads no user settings", () => {
    const options = buildClaudeAgentOptions({
      cwd: "/work/project",
      model: "claude-sonnet-5",
      apiKey: "sk-ant-api-test",
      environment: { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
      sparkyMcp: {
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer sparky-token",
      },
      systemPromptAppend: "Sparky skill",
      permissionMode: "default",
      resumeSessionId: "session-123",
      abortController: new AbortController(),
      canUseTool,
    });

    expect(options.cwd).toBe("/work/project");
    expect(options.model).toBe("claude-sonnet-5");
    expect(options.settingSources).toEqual([]);
    expect(options.resume).toBe("session-123");
    expect(options.includePartialMessages).toBe(true);
    expect(options.allowedTools).toEqual([sparkyMcpToolPattern]);
    expect(options.mcpServers).toEqual({
      sparky: {
        type: "http",
        url: "http://127.0.0.1:3773/mcp",
        headers: { Authorization: "Bearer sparky-token" },
      },
    });
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Sparky skill",
    });
    const env = options.env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api-test");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("omits the MCP bridge and resume when there is no Sparky session", () => {
    const options = buildClaudeAgentOptions({
      cwd: "/work/project",
      model: undefined,
      apiKey: "sk-ant-api-test",
      environment: {},
      sparkyMcp: undefined,
      systemPromptAppend: "",
      permissionMode: "default",
      resumeSessionId: undefined,
      abortController: new AbortController(),
      canUseTool,
    });
    expect(options.mcpServers).toEqual({});
    expect(options.allowedTools).toEqual([]);
    expect(options.resume).toBeUndefined();
    expect(options.model).toBeUndefined();
  });
});
