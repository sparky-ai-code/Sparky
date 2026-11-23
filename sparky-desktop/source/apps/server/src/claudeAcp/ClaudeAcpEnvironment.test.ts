import { describe, expect, it } from "vite-plus/test";

import { buildClaudeAcpEnvironment } from "./ClaudeAcpEnvironment.ts";

describe("buildClaudeAcpEnvironment", () => {
  it("passes only allow-listed host variables, so Sparky's own secrets stay out", () => {
    const env = buildClaudeAcpEnvironment({
      ambient: {
        PATH: "/bin",
        HOME: "/home/me",
        ANTHROPIC_API_KEY: "sk-ant-from-sparky-models",
        SOME_SECRET: "do-not-pass",
      },
    });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/me");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SOME_SECRET).toBeUndefined();
  });

  it("applies the variables the user set on the provider instance", () => {
    const env = buildClaudeAcpEnvironment({
      ambient: { PATH: "/bin" },
      instanceOverrides: [
        { name: "CLAUDE_CONFIG_DIR", value: "/home/me/.claude_work" },
        { name: "CLAUDE_CODE_EXECUTABLE", value: "/opt/claude/bin/claude" },
      ],
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/me/.claude_work");
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/opt/claude/bin/claude");
  });

  it("lets an instance override an ambient value", () => {
    const env = buildClaudeAcpEnvironment({
      ambient: { PATH: "/bin" },
      instanceOverrides: [{ name: "PATH", value: "/custom" }],
    });
    expect(env.PATH).toBe("/custom");
  });
});
