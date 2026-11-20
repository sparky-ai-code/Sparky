import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

/**
 * Minimal stdio MCP client for the CUADriver binary (`cua-driver mcp`).
 *
 * The driver keeps per-process state (e.g. element indices from a window
 * snapshot), so one long-lived process is reused across tool calls instead of
 * spawning per call.
 */

export interface ComputerUseDriverOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
}

export interface ComputerUseDriver {
  readonly listTools: () => Promise<ReadonlyArray<unknown>>;
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly close: () => void;
}

type Pending = {
  readonly resolve: (value: Record<string, unknown> | undefined) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export function makeComputerUseDriver(options: ComputerUseDriverOptions): ComputerUseDriver {
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let ready: Promise<void> | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (error: Error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  };

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const proc = child;
      if (!proc || !proc.stdin.writable) {
        reject(new Error("Computer-use driver is not running."));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Computer-use driver timed out on ${method}.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const start = () => {
    const proc = NodeChildProcess.spawn(options.command, [...(options.args ?? ["mcp"])], {
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    proc.stderr.resume();
    NodeReadline.createInterface({ input: proc.stdout }).on("line", (line) => {
      let message: {
        id?: unknown;
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(message.error.message ?? "Computer-use driver error."));
      } else {
        entry.resolve(message.result);
      }
    });
    const onGone = (error: Error) => {
      if (child === proc) {
        child = undefined;
        ready = undefined;
      }
      failAll(error);
    };
    proc.once("error", (cause) =>
      onGone(new Error(`Could not start computer-use driver '${options.command}': ${cause.message}`)),
    );
    proc.once("exit", () => onGone(new Error("Computer-use driver exited.")));
    return request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "Sparky", version: "1.0.0" },
    }).then(() => {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    });
  };

  const ensure = () => {
    ready ??= start().catch((error) => {
      ready = undefined;
      child?.kill();
      child = undefined;
      throw error;
    });
    return ready;
  };

  return {
    listTools: async () => {
      await ensure();
      const tools: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const result = await request("tools/list", cursor ? { cursor } : {});
        if (Array.isArray(result?.tools)) tools.push(...result.tools);
        if (typeof result?.nextCursor !== "string" || !result.nextCursor) return tools;
        cursor = result.nextCursor;
      }
      throw new Error("Computer-use driver returned too many tool pages.");
    },
    callTool: async (name, args) => {
      await ensure();
      return (await request("tools/call", { name, arguments: args })) ?? null;
    },
    close: () => {
      const proc = child;
      child = undefined;
      ready = undefined;
      failAll(new Error("Computer-use driver closed."));
      proc?.kill();
    },
  };
}

const DEFAULT_COMMAND = "cua-driver";

let shared: { readonly command: string; readonly driver: ComputerUseDriver } | undefined;

/** Shared driver for the desktop session. Restarts if the configured binary changes. */
export function getSharedComputerUseDriver(
  environment: NodeJS.ProcessEnv = process.env,
): ComputerUseDriver {
  const command = environment.SPARKY_CUA_DRIVER_PATH?.trim() || DEFAULT_COMMAND;
  if (shared && shared.command !== command) {
    shared.driver.close();
    shared = undefined;
  }
  shared ??= { command, driver: makeComputerUseDriver({ command, env: environment }) };
  return shared.driver;
}

export function closeSharedComputerUseDriver(): void {
  shared?.driver.close();
  shared = undefined;
}
