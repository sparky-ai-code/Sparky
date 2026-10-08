// @effect-diagnostics nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import type { ResolvedSpawnCommand } from "@sparky/shared/shell";

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** ACP uses newline-delimited JSON-RPC, not LSP Content-Length framing. */
export class AcpConnection {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private nextId = 0;
  private closed = false;
  private terminating = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown> = async () => {
    throw new Error("Unsupported ACP client method");
  };
  onExit: (error: Error) => void = () => {};

  constructor(command: ResolvedSpawnCommand, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = NodeChildProcess.spawn(command.command, [...command.args], {
      cwd,
      env,
      shell: command.shell,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: "pipe",
    });
    // Drain stderr, but never expose harness output that may contain credentials.
    this.child.stderr.resume();
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () =>
      this.fail(new Error("ACP harness exited. Check its installation and CLI login.")),
    );
    const lines = NodeReadline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        this.receive(record(JSON.parse(line)));
      } catch {
        this.fail(new Error("Invalid JSON received from ACP harness."));
      }
    });
    this.child.on("close", () => lines.close());
  }

  private write(message: unknown): void {
    if (this.closed) throw new Error("ACP connection is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("ACP connection is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out`));
        // A timed-out prompt must not continue editing after the UI settles.
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private receive(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      const method = message.method;
      const params = record(message.params);
      if (message.id === undefined) {
        this.onNotification(method, params);
        return;
      }
      void this.onRequest(method, params).then(
        (result) => {
          if (!this.closed) this.write({ jsonrpc: "2.0", id: message.id, result });
        },
        () => {
          if (!this.closed)
            this.write({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Unsupported or invalid ACP client request" },
            });
        },
      );
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      // Protocol errors are useful, but raw provider payloads may contain secrets.
      const code = record(message.error).code;
      pending.reject(
        new Error(
          `ACP request failed (${String(code)}). Verify the harness CLI login and session support.`,
        ),
      );
    } else {
      pending.resolve(record(message.result));
    }
  }

  private terminateProcessTree(): void {
    if (this.terminating) return;
    this.terminating = true;
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      NodeChildProcess.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
      return;
    }
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          this.child.kill(signal);
        } catch {
          // The process may have exited between the signal attempts.
        }
      }
    };
    signalGroup("SIGTERM");
    const forceKill = setTimeout(() => signalGroup("SIGKILL"), 1_000);
    forceKill.unref();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.terminateProcessTree();
    this.onExit(error);
  }

  close(): void {
    this.fail(new Error("ACP connection closed"));
  }
}
