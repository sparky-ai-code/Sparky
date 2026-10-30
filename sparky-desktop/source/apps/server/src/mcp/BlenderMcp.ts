import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { BlenderMcpSettings } from "@sparky/contracts";

type JsonRpcResponse = {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
};

type Request = {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type SpawnProcess = typeof spawn;

function createTransport(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<
    number,
    { resolve: (response: JsonRpcResponse) => void; reject: (error: Error) => void }
  >();
  const output = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
  });
  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  output.on("line", (line) => {
    let response: JsonRpcResponse;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid JSON-RPC frame.");
      response = parsed as JsonRpcResponse;
    } catch {
      rejectPending(new Error("Blender MCP wrote invalid data to stdout."));
      return;
    }
    if (typeof response.id !== "number") return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) {
      request.reject(new Error(response.error.message ?? "Blender MCP returned an error."));
    } else {
      request.resolve(response);
    }
  });
  child.on("error", (cause) => {
    rejectPending(new Error(cause.message || "Unable to start Blender MCP."));
  });
  child.on("exit", (code, signal) => {
    const detail = stderr.trim();
    rejectPending(
      new Error(
        `Blender MCP exited ${signal ? `with signal ${signal}` : `with code ${String(code)}`}.${detail ? ` ${detail}` : ""}`,
      ),
    );
  });

  return {
    request(request: Request): Promise<JsonRpcResponse> {
      if (request.id === undefined) {
        return new Promise((resolve, reject) => {
          child.stdin.write(`${JSON.stringify(request)}\n`, (error) =>
            error ? reject(error) : resolve({}),
          );
        });
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(request.id!);
          reject(new Error(`Blender MCP timed out during ${request.method}.`));
        }, 30_000);
        pending.set(request.id!, {
          resolve: (response) => {
            clearTimeout(timeout);
            resolve(response);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (!error) return;
          pending.delete(request.id!);
          clearTimeout(timeout);
          reject(error);
        });
      });
    },
    close: async () => {
      output.close();
      child.stdin.end();
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (child.exitCode === null) child.kill();
          resolve();
        }, 1_500);
        child.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

async function withBlenderMcp<T>(
  settings: BlenderMcpSettings,
  operation: (transport: ReturnType<typeof createTransport>) => Promise<T>,
  spawnProcess: SpawnProcess = spawn,
): Promise<T> {
  let directoryPath = settings.directoryPath.trim();
  if (!directoryPath) throw new Error("Choose the Blender MCP folder in settings first.");
  if (!isAbsolute(directoryPath)) throw new Error("The Blender MCP folder path must be absolute.");
  const directory = await stat(directoryPath).catch(() => null);
  if (!directory?.isDirectory()) {
    throw new Error("The selected Blender MCP folder does not exist.");
  }
  const nestedMcpDirectory = await stat(join(directoryPath, "mcp")).catch(() => null);
  if (nestedMcpDirectory?.isDirectory()) directoryPath = join(directoryPath, "mcp");

  const child = spawnProcess("uv", ["--directory", directoryPath, "run", "blender-mcp"], {
    cwd: directoryPath,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const transport = createTransport(child);
  try {
    const initialized = await transport.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "Sparky Blender MCP", version: "1.0.0" },
      },
    });
    if (!initialized.result) throw new Error("Blender MCP returned an invalid initialize response.");
    await transport.request({ jsonrpc: "2.0", method: "notifications/initialized" });
    return await operation(transport);
  } finally {
    await transport.close();
  }
}

export function blenderMcpConnectionHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|spawn uv|uv.*not found/i.test(message)) {
    return "Install uv, then restart Sparky so it can find it.";
  }
  if (/folder path|blender mcp folder|directory/i.test(message)) {
    return "Choose the downloaded Blender MCP folder or its mcp subfolder.";
  }
  if (/timed out|exited|invalid initialize response/i.test(message)) {
    return "Open Blender and turn on the MCP add-on, then try again.";
  }
  return "Check that uv is installed and the Blender MCP add-on is running in Blender.";
}

export function listBlenderMcpTools(
  settings: BlenderMcpSettings,
  spawnProcess?: SpawnProcess,
): Promise<unknown> {
  return withBlenderMcp(
    settings,
    async (transport) => {
      const response = await transport.request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const tools = (response.result as { readonly tools?: unknown } | undefined)?.tools;
      return Array.isArray(tools) ? tools : [];
    },
    spawnProcess,
  );
}

export function callBlenderMcpTool(
  settings: BlenderMcpSettings,
  toolName: string,
  arguments_: Record<string, unknown>,
  spawnProcess?: SpawnProcess,
): Promise<unknown> {
  return withBlenderMcp(
    settings,
    async (transport) => {
      const response = await transport.request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: arguments_ },
      });
      return response.result ?? null;
    },
    spawnProcess,
  );
}
