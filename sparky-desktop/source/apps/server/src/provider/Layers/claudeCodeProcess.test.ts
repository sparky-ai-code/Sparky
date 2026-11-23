// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { findClaudeExecutable, resolveClaudeExecutablePath } from "./claudeCodeProcess.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sparky-claude-detect-"));
  temporaryDirectories.push(home);
  return home;
}

describe("findClaudeExecutable", () => {
  it("prefers a Claude executable on PATH", () => {
    const home = makeHome();
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin);
    const executable = NodePath.join(bin, "claude");
    NodeFS.writeFileSync(executable, "");

    expect(findClaudeExecutable({ PATH: bin, HOME: home }, "linux", home)).toBe(executable);
  });

  it("uses the native Windows executable name", () => {
    if (process.platform !== "win32") return;
    const home = makeHome();
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin);
    const executable = NodePath.join(bin, "claude.exe");
    NodeFS.writeFileSync(executable, "");

    expect(findClaudeExecutable({ PATH: bin, USERPROFILE: home }, "win32", home)).toBe(executable);
  });

  it("resolves the Windows executable alias from native install locations", () => {
    if (process.platform !== "win32") return;
    const home = makeHome();
    const bin = NodePath.win32.join(home, ".local", "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    const executable = NodePath.win32.join(bin, "claude.exe");
    NodeFS.writeFileSync(executable, "");

    expect(resolveClaudeExecutablePath("claude.exe", { USERPROFILE: home }, "win32", home)).toBe(executable);
  });

  it("does not replace an explicitly configured custom executable", () => {
    const home = makeHome();
    expect(resolveClaudeExecutablePath("custom-claude", { HOME: home }, "linux", home)).toBeUndefined();
  });

  it("finds a native install in the user's local bin directory", () => {
    const home = makeHome();
    const bin = NodePath.join(home, ".local", "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    const executable = NodePath.join(bin, "claude");
    NodeFS.writeFileSync(executable, "");

    expect(findClaudeExecutable({ PATH: "", HOME: home }, "linux", home)).toBe(executable);
  });

  it("returns no path when Claude is not installed in known locations", () => {
    const home = makeHome();

    expect(findClaudeExecutable({ PATH: "", HOME: home }, "linux", home)).toBeUndefined();
  });
});
