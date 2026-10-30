import { expect, it } from "@effect/vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BlenderMcpSettings } from "@sparky/contracts";

import {
  blenderMcpConnectionHint,
  callBlenderMcpTool,
  listBlenderMcpTools,
} from "./BlenderMcp.ts";

const settings = (directoryPath: string): BlenderMcpSettings => ({
  enabled: true,
  directoryPath,
});

const fakeBlenderServer = `
  const readline = require("node:readline").createInterface({ input: process.stdin });
  readline.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-03-26" }
      : request.method === "tools/list"
        ? { tools: [{ name: "create_object" }] }
        : { content: [{ type: "text", text: "created" }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  });
`;

const spawnFakeBlender = ((
  _command: string,
  _args: string[],
  options: Parameters<typeof spawn>[2],
) => spawn(process.execPath, ["-e", fakeBlenderServer], options) as ChildProcessWithoutNullStreams) as typeof spawn;

it("lists Blender MCP tools over stdio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sparky-blender-mcp-"));
  try {
    await expect(listBlenderMcpTools(settings(directory), spawnFakeBlender)).resolves.toEqual([
      { name: "create_object" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("calls Blender MCP tools over stdio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sparky-blender-mcp-"));
  try {
    await expect(
      callBlenderMcpTool(settings(directory), "create_object", { name: "Cube" }, spawnFakeBlender),
    ).resolves.toEqual({ content: [{ type: "text", text: "created" }] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("accepts the repository root and uses its mcp subfolder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sparky-blender-mcp-"));
  const mcpDirectory = join(directory, "mcp");
  let spawnedDirectory = "";
  try {
    await mkdir(mcpDirectory);
    const captureSpawn = ((
      _command: string,
      args: string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      spawnedDirectory = args[1] ?? "";
      return spawn(process.execPath, ["-e", fakeBlenderServer], options);
    }) as typeof spawn;

    await listBlenderMcpTools(settings(directory), captureSpawn);
    expect(spawnedDirectory).toBe(mcpDirectory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("shows an actionable hint when uv is missing", () => {
  expect(blenderMcpConnectionHint(new Error("spawn uv ENOENT"))).toContain("Install uv");
});
