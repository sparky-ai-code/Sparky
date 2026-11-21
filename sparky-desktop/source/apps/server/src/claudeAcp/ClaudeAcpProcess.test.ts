import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { claudeAcpLaunchFailureMessage, probeClaudeAcp } from "./ClaudeAcpProcess.ts";

const fakeAgent = fileURLToPath(new URL("./testing/fakeClaudeAcpAgent.mjs", import.meta.url));

describe("probeClaudeAcp", () => {
  it("runs initialize against the adapter and reports what it supports", async () => {
    const probe = await probeClaudeAcp({
      launch: {
        command: process.execPath,
        args: [fakeAgent],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
      },
    });
    expect(probe).toEqual({
      ok: true,
      agentName: "Fake Claude",
      agentVersion: "0.0.0",
      authMethods: [],
    });
  }, 30_000);

  it("reports a missing adapter with the install steps", async () => {
    const probe = await probeClaudeAcp({
      launch: {
        command: "sparky-no-such-claude-adapter-xyz",
        args: [],
        cwd: process.cwd(),
        env: {},
      },
      timeoutMs: 5_000,
    });
    expect(probe.ok).toBe(false);
    if (!probe.ok)
      expect(probe.reason).toContain("npm install -g @agentclientprotocol/claude-agent-acp");
  }, 30_000);
});

describe("claudeAcpLaunchFailureMessage", () => {
  it("returns install guidance only for a missing executable", () => {
    expect(claudeAcpLaunchFailureMessage("claude-agent-acp", { code: "ENOENT" })).toContain(
      "was not found",
    );
    expect(claudeAcpLaunchFailureMessage("claude-agent-acp", new Error("boom"))).toBeUndefined();
  });
});
