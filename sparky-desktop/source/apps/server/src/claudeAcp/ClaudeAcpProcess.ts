// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * One running Claude ACP adapter process, and the ACP client connection to it.
 *
 * Sparky is the ACP client. The adapter (`claude-agent-acp` by default) runs the
 * Claude Code harness. Sparky never calls a model API and never touches a
 * credential: sign-in belongs to Claude Code, and the adapter reads it there.
 *
 * @module claudeAcp/ClaudeAcpProcess
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type ResumeSessionResponse,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

export interface ClaudeAcpLaunch {
  /** Executable name or absolute path. Launched directly, with no shell. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ClaudeAcpCallbacks {
  /** Every `session/update` the adapter sends. */
  readonly onUpdate: (notification: SessionNotification) => void;
  /** A `session/request_permission` the adapter needs answered. */
  readonly onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

/** Sparky does not advertise file or terminal access; the adapter uses its own. */
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

export class ClaudeAcpProcess {
  private stderrText = "";
  private readonly child: ChildProcess;
  readonly connection: ClientConnection;

  private constructor(child: ChildProcess, connection: ClientConnection) {
    this.child = child;
    this.connection = connection;
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep the tail only; the adapter logs verbosely.
      this.stderrText = (this.stderrText + chunk.toString("utf8")).slice(-4000);
    });
  }

  /** Recent stderr from the adapter, for diagnostics. Never contains a credential by design. */
  get stderr(): string {
    return this.stderrText;
  }

  /**
   * Launch the adapter and connect over its stdio. Rejects if the executable
   * cannot be started (for example, not installed).
   */
  static start(launch: ClaudeAcpLaunch, callbacks: ClaudeAcpCallbacks): Promise<ClaudeAcpProcess> {
    const child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const app = client({ name: "sparky" })
      .onNotification(methods.client.session.update, ({ params }) => {
        callbacks.onUpdate(params);
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) =>
        callbacks.onPermission(params),
      );
    const connection = app.connect(stream);
    return new Promise<ClaudeAcpProcess>((resolve, reject) => {
      child.once("error", (error) => {
        connection.close(error);
        reject(error);
      });
      child.once("spawn", () => resolve(new ClaudeAcpProcess(child, connection)));
    });
  }

  initialize(): Promise<InitializeResponse> {
    return this.connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: "sparky", title: "Sparky", version: "1" },
    });
  }

  newSession(input: {
    readonly cwd: string;
    readonly mcpServers: ReadonlyArray<McpServer>;
  }): Promise<NewSessionResponse> {
    return this.connection.agent.request(methods.agent.session.new, {
      cwd: input.cwd,
      mcpServers: [...input.mcpServers],
    });
  }

  resumeSession(input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mcpServers: ReadonlyArray<McpServer>;
  }): Promise<ResumeSessionResponse> {
    return this.connection.agent.request(methods.agent.session.resume, {
      sessionId: input.sessionId,
      cwd: input.cwd,
      mcpServers: [...input.mcpServers],
    });
  }

  prompt(input: {
    readonly sessionId: string;
    readonly prompt: ReadonlyArray<ContentBlock>;
  }): Promise<PromptResponse> {
    return this.connection.agent.request(methods.agent.session.prompt, {
      sessionId: input.sessionId,
      prompt: [...input.prompt],
    });
  }

  /** Ask the adapter to stop the running prompt. The prompt then resolves as cancelled. */
  cancel(sessionId: string): Promise<void> {
    return this.connection.agent.notify(methods.agent.session.cancel, { sessionId });
  }

  close(): void {
    this.connection.close();
    if (!this.child.killed) this.child.kill();
  }
}

/**
 * A user-facing message when the adapter could not be started, or undefined for
 * other errors. A missing executable gets the install steps.
 */
export function claudeAcpLaunchFailureMessage(command: string, error: unknown): string | undefined {
  const code = (error as { code?: string } | undefined)?.code;
  if (code !== "ENOENT") return undefined;
  return `The Claude ACP adapter "${command}" was not found. Install it with \`npm install -g @agentclientprotocol/claude-agent-acp\`, or set its full path in this provider's settings.`;
}

export type ClaudeAcpProbe =
  | {
      readonly ok: true;
      readonly agentName: string | undefined;
      readonly agentVersion: string | undefined;
      readonly authMethods: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Start the adapter, run `initialize`, and stop it. This makes no model request
 * and reads no credential. It only confirms the adapter runs and reports what it
 * supports.
 */
export async function probeClaudeAcp(input: {
  readonly launch: ClaudeAcpLaunch;
  readonly timeoutMs?: number | undefined;
}): Promise<ClaudeAcpProbe> {
  const noopCallbacks: ClaudeAcpCallbacks = {
    onUpdate: () => undefined,
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  };
  let proc: ClaudeAcpProcess | undefined;
  try {
    proc = await ClaudeAcpProcess.start(input.launch, noopCallbacks);
    const init = await withTimeout(proc.initialize(), input.timeoutMs ?? 20_000);
    return {
      ok: true,
      agentName: init.agentInfo?.title ?? init.agentInfo?.name,
      agentVersion: init.agentInfo?.version,
      authMethods: (init.authMethods ?? []).map((method) => method.name),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        claudeAcpLaunchFailureMessage(input.launch.command, error) ??
        (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    proc?.close();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("The Claude ACP adapter did not respond in time.")),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
