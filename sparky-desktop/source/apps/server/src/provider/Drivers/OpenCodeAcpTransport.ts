import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

export interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface OpenCodeAcpTransport {
  readonly request: (method: string, params?: unknown) => Promise<unknown>;
  readonly notify: (method: string, params?: unknown) => void;
  readonly respond: (id: string | number, result?: unknown, error?: JsonRpcMessage["error"]) => void;
  readonly close: () => void;
  readonly isRunning: () => boolean;
  readonly onMessage: (handler: (message: JsonRpcMessage) => void) => () => void;
  readonly onExit: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => () => void;
}

/**
 * Start OpenCode in ACP mode. ACP uses newline-delimited JSON-RPC over stdio;
 * stdout is reserved exclusively for protocol frames and stderr remains available
 * for diagnostics. No shell is involved, so configured binary paths are safe.
 */
export function spawnOpenCodeAcp(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): OpenCodeAcpTransport {
  const child = NodeChildProcess.spawn(input.binaryPath, ["acp"], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const messageHandlers = new Set<(message: JsonRpcMessage) => void>();
  const exitHandlers = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >();
  const pending = new Map<
    string | number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  let nextId = 1;
  let closed = false;

  const rejectPending = (error: Error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  const lines = NodeReadline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: JsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || (parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
        return;
      }
      message = parsed as JsonRpcMessage;
    } catch {
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    if (message.id !== undefined && pending.has(message.id) && (hasResult || message.error !== undefined)) {
      const current = pending.get(message.id);
      if (!current) return;
      pending.delete(message.id);
      if (message.error) current.reject(new Error(message.error.message));
      else current.resolve(message.result);
      return;
    }
    for (const handler of messageHandlers) handler(message);
  });
  child.once("error", (error) => rejectPending(error));
  child.once("exit", (code, signal) => {
    closed = true;
    rejectPending(new Error(`OpenCode ACP exited (code=${String(code)}, signal=${String(signal)}).`));
    for (const handler of exitHandlers) handler(code, signal);
  });

  const send = (message: JsonRpcMessage) => {
    if (closed || !child.stdin.writable) throw new Error("OpenCode ACP process is not running.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    respond(id, result, error) {
      send({ jsonrpc: "2.0", id, ...(error ? { error } : { result: result ?? null }) });
    },
    close() {
      if (closed) return;
      closed = true;
      child.kill();
      rejectPending(new Error("OpenCode ACP process was closed."));
    },
    isRunning() {
      return !closed && child.exitCode === null;
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
  };
}
