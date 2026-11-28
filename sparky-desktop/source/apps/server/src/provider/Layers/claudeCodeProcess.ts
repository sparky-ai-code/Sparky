// @effect-diagnostics nodeBuiltinImport:off
import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { createInterface } from "node:readline";
import type { ChatAttachment } from "@sparky/contracts";

import { resolveAttachmentPath } from "../../attachmentStore.ts";

export type ClaudeJson = Record<string, unknown>;
export type ClaudeInputBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string };
    };

export interface ClaudeExecutable {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** Resolve Claude Code from PATH first, then common native-install locations. */
export function findClaudeExecutable(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home = environment.USERPROFILE?.trim() || environment.HOME?.trim() || homedir(),
): string | undefined {
  const pathApi = platform === "win32" ? win32 : { join };
  const pathEntries = (environment.PATH ?? environment.Path ?? environment.path ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
  const binaryNames = platform === "win32" ? ["claude.exe"] : ["claude"];
  const candidates = pathEntries.flatMap((entry) => binaryNames.map((name) => pathApi.join(entry, name)));
  const localData = environment.LOCALAPPDATA?.trim();
  candidates.push(
    ...(platform === "win32"
      ? [
          pathApi.join(home, ".local", "bin", "claude.exe"),
          pathApi.join(home, ".claude", "local", "claude.exe"),
          ...(localData ? [pathApi.join(localData, "Programs", "Claude Code", "claude.exe")] : []),
        ]
      : [pathApi.join(home, ".local", "bin", "claude"), pathApi.join(home, ".claude", "local", "claude")]),
  );
  const seen = new Set<string>();
  return candidates.find((candidate) => {
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Resolve the standard executable aliases to a discovered absolute path.
 * Windows users commonly configure `claude.exe`, while the default config
 * uses `claude`; both should benefit from the same PATH and install-location
 * detection instead of relying on the process PATH at launch time.
 */
export function resolveClaudeExecutablePath(
  configuredBinary: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home = environment.USERPROFILE?.trim() || environment.HOME?.trim() || homedir(),
): string | undefined {
  const command = configuredBinary.trim().toLowerCase();
  const isDefaultAlias = platform === "win32"
    ? command === "claude" || command === "claude.exe"
    : command === "claude";
  return isDefaultAlias ? findClaudeExecutable(environment, platform, home) : undefined;
}

export function parseClaudeLaunchArgs(value: string): ReadonlyArray<string> {
  const args: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) args.push(token);
      token = "";
      started = false;
    } else {
      token += character;
      started = true;
    }
  }
  if (escaped || quote) throw new Error("Claude Code launch arguments contain an unmatched quote or escape.");
  if (started) args.push(token);
  return args;
}

export function asClaudeJson(value: unknown): ClaudeJson | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ClaudeJson)
    : undefined;
}

export async function loadClaudeInput(
  text: string,
  attachments: ReadonlyArray<ChatAttachment>,
  attachmentsDir: string,
): Promise<ReadonlyArray<ClaudeInputBlock>> {
  const content: ClaudeInputBlock[] = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const attachment of attachments) {
    if (attachment.type !== "image" || !/^image\/(jpeg|png|gif|webp)$/u.test(attachment.mimeType)) {
      throw new Error(`Claude Code supports PNG, JPEG, GIF and WebP images: ${attachment.name}.`);
    }
    const path = resolveAttachmentPath({ attachmentsDir, attachment });
    const bytes = path ? await readFile(path).catch(() => undefined) : undefined;
    if (!bytes?.length) throw new Error(`Could not load image '${attachment.name}'.`);
    content.push({
      type: "image",
      source: { type: "base64", media_type: attachment.mimeType, data: bytes.toString("base64") },
    });
  }
  return content;
}

export function makeClaudeUserMessage(content: ReadonlyArray<ClaudeInputBlock>, sessionId = "") {
  return { type: "user", session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content } };
}

export function probeClaude(executable: ClaudeExecutable, args: ReadonlyArray<string>, cwd: string, signal: AbortSignal) {
  return new Promise<{ readonly stdout: string; readonly ok: boolean }>((resolve) => {
    execFile(executable.binaryPath, [...args], {
      cwd,
      env: executable.environment,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
      signal,
    }, (error, stdout) => resolve({ stdout, ok: error === null }));
  });
}

/** Claude Code's native JSONL protocol. `result`, not process exit, settles a turn. */
export function runClaudeProcess(options: ClaudeExecutable & {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly content: ReadonlyArray<ClaudeInputBlock>;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
  readonly onFrame?: (frame: ClaudeJson, write: (value: ClaudeJson) => void) => void;
}): Promise<ClaudeJson> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(new Error("Claude Code was interrupted."));
    const child = spawn(options.binaryPath, [
      "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      ...options.args,
    ], {
      cwd: options.cwd,
      env: options.environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false;
    let stderr = "";
    const finish = (error: Error | null, frame?: ClaudeJson) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(error);
      else if (frame) resolve(frame);
    };
    const abort = () => finish(new Error("Claude Code was interrupted."));
    const write = (value: ClaudeJson) => {
      if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => finish(new Error(`Could not launch Claude Code: ${error.message}`)));
    child.stdin.on("error", (error) => finish(error));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_048);
    });
    child.once("close", (code) => finish(new Error(
      `Claude Code exited without a result (${code ?? "signal"}).${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
    )));
    lines.on("line", (line) => {
      if (settled || !line.trim()) return;
      try {
        const frame = asClaudeJson(JSON.parse(line));
        if (!frame) return;
        if (frame.type === "result") finish(null, frame);
        else options.onFrame?.(frame, write);
      } catch (error) {
        finish(new Error("Invalid Claude Code stream frame.", { cause: error }));
      }
    });
    write({
      type: "control_request",
      request: { subtype: "initialize", request_id: "sparky-init", sdk_mcp_servers: [] },
    });
    write(makeClaudeUserMessage(options.content, options.sessionId));
    if (!options.onFrame) child.stdin.end();
  });
}

export function claudeResultError(frame: ClaudeJson): string | undefined {
  if (frame.subtype === "success" && frame.is_error !== true) return undefined;
  const errors = Array.isArray(frame.errors)
    ? frame.errors.filter((value): value is string => typeof value === "string").join("\n")
    : "";
  return errors.trim() || (typeof frame.result === "string" ? frame.result.trim() : "") ||
    "Claude Code could not complete the turn. Check its installation and sign-in.";
}
