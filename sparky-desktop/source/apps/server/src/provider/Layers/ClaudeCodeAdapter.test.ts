// @effect-diagnostics nodeBuiltinImport:off
import { ThreadId } from "@sparky/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_NO_WORKSPACE_ARGS,
  claudeSessionArgs,
  readClaudeCursor,
} from "./ClaudeCodeAdapter.ts";
import { claudeResultError, parseClaudeLaunchArgs } from "./claudeCodeProcess.ts";

const SESSION_ID = "3f2b8c1e-9a4d-4b7e-8c2a-1d5e6f7a8b9c";
const THREAD_ID = ThreadId.make("thread-claude-1");
const CWD = "/workspace/project";

describe("readClaudeCursor", () => {
  it("accepts a cursor bound to the same thread and workspace", () => {
    const cursor = readClaudeCursor(
      { claudeSessionId: SESSION_ID, threadId: THREAD_ID, cwd: CWD },
      THREAD_ID,
      CWD,
    );

    expect(cursor).toEqual({ claudeSessionId: SESSION_ID, threadId: THREAD_ID, cwd: CWD });
  });

  it("rejects a cursor from another workspace instead of silently starting over", () => {
    expect(() =>
      readClaudeCursor(
        { claudeSessionId: SESSION_ID, threadId: THREAD_ID, cwd: "/elsewhere" },
        THREAD_ID,
        CWD,
      ),
    ).toThrow(/cannot resume this conversation/u);
  });

  it("rejects a cursor from another thread", () => {
    expect(() =>
      readClaudeCursor(
        { claudeSessionId: SESSION_ID, threadId: ThreadId.make("other-thread"), cwd: CWD },
        THREAD_ID,
        CWD,
      ),
    ).toThrow(/cannot resume this conversation/u);
  });

  it("rejects a cursor whose session ID is not a UUID", () => {
    expect(() =>
      readClaudeCursor(
        { claudeSessionId: "not-a-uuid", threadId: THREAD_ID, cwd: CWD },
        THREAD_ID,
        CWD,
      ),
    ).toThrow(/cannot resume this conversation/u);
  });

  it("rejects a missing cursor", () => {
    expect(() => readClaudeCursor(undefined, THREAD_ID, CWD)).toThrow(
      /cannot resume this conversation/u,
    );
  });
});

describe("claudeSessionArgs", () => {
  const cursor = { claudeSessionId: SESSION_ID, threadId: THREAD_ID, cwd: CWD };

  it("creates a new session with a fixed ID on the first turn", () => {
    expect(claudeSessionArgs(cursor, false)).toEqual(["--session-id", SESSION_ID]);
  });

  it("resumes the saved session on later turns", () => {
    expect(claudeSessionArgs(cursor, true)).toEqual(["--resume", SESSION_ID]);
  });
});

describe("CLAUDE_NO_WORKSPACE_ARGS", () => {
  it("disables tools and MCP servers for chats without a project", () => {
    expect(CLAUDE_NO_WORKSPACE_ARGS).toEqual([
      "--setting-sources",
      "user",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ]);
  });
});

describe("parseClaudeLaunchArgs", () => {
  it("returns no arguments for a blank setting", () => {
    expect(parseClaudeLaunchArgs("   ")).toEqual([]);
  });

  it("splits plain whitespace-separated flags", () => {
    expect(parseClaudeLaunchArgs("--chrome --verbose")).toEqual(["--chrome", "--verbose"]);
  });

  it("keeps quoted values together", () => {
    expect(parseClaudeLaunchArgs(`--append-system-prompt "be brief" '--name=My Chat'`)).toEqual([
      "--append-system-prompt",
      "be brief",
      "--name=My Chat",
    ]);
  });

  it("honors backslash escapes outside single quotes", () => {
    expect(parseClaudeLaunchArgs("path\\ with\\ spaces")).toEqual(["path with spaces"]);
    expect(parseClaudeLaunchArgs("'C:\\Program Files\\x'")).toEqual(["C:\\Program Files\\x"]);
  });

  it("rejects an unmatched quote", () => {
    expect(() => parseClaudeLaunchArgs(`--model "sonnet`)).toThrow(/unmatched quote/u);
  });
});

describe("claudeResultError", () => {
  it("treats a successful result as no error", () => {
    expect(
      claudeResultError({ type: "result", subtype: "success", is_error: false }),
    ).toBeUndefined();
  });

  it("prefers the structured error list", () => {
    expect(
      claudeResultError({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Rate limited", 42, "Try again later"],
        result: "ignored",
      }),
    ).toBe("Rate limited\nTry again later");
  });

  it("falls back to the result text", () => {
    expect(
      claudeResultError({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in",
      }),
    ).toBe("Not logged in");
  });

  it("uses a setup hint when the frame carries no detail", () => {
    expect(claudeResultError({ type: "result", subtype: "error", is_error: true })).toMatch(
      /Check its installation and sign-in/u,
    );
  });
});
