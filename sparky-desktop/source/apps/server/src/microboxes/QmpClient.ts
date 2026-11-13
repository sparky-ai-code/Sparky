// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Local VM monitor transport.
import type { ChildProcessWithoutNullStreams } from "node:child_process";

type Reply = { id?: string; return?: unknown; error?: { desc?: string }; QMP?: unknown };

export class QmpClient {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private seq = 0;
  private buffer = "";
  private readyResolve!: () => void;
  private readyReject!: (cause: Error) => void;
  private readonly readyPromise: Promise<void>;
  private greeting = false;
  private closed = false;
  private processClosed = false;
  private stopPromise: Promise<void> | undefined;
  private readonly process: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.process = child;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.on("error", (cause) => this.close(cause));
    child.on("exit", () => this.close(new Error("The box has stopped.")));
    child.on("close", () => { this.processClosed = true; });
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1_000_000) {
      this.close(new Error("Invalid VM monitor data."));
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const raw = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!raw) continue;
      let message: Reply;
      try {
        message = JSON.parse(raw) as Reply;
      } catch {
        continue;
      }
      if (message.QMP && !this.greeting) {
        this.greeting = true;
        void this.command("qmp_capabilities", {}, true).then(
          () => this.readyResolve(),
          (cause: Error) => this.readyReject(cause),
        );
        continue;
      }
      if (!message.id) continue; // asynchronous QMP events
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.desc ?? "VM monitor error."));
      else pending.resolve(message.return);
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.greeting) this.readyReject(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async command(
    execute: string,
    args: Record<string, unknown> = {},
    beforeReady = false,
  ): Promise<unknown> {
    if (!beforeReady) await this.ready;
    if (this.closed) throw new Error("The box is not running.");
    const id = `box-${++this.seq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The VM did not respond."));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ execute, arguments: args, id }) + "\n", (err) => {
        if (!err) return;
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  stop(): Promise<void> {
    this.close(new Error("Box stopped."));
    if (this.stopPromise) return this.stopPromise;
    // On Windows, kill() only requests termination; QEMU can still hold
    // boot-serial.log and the disk handles for a short time afterwards.
    // Wait for the child "close" event (not just "exit") before deleting files.
    this.stopPromise = new Promise<void>((resolve) => {
      if (this.processClosed) {
        resolve();
        return;
      }
      let finished = false;
      let terminateTimer: ReturnType<typeof setTimeout> | undefined;
      let lastResortTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (terminateTimer) clearTimeout(terminateTimer);
        if (lastResortTimer) clearTimeout(lastResortTimer);
        this.process.off("close", finish);
        resolve();
      };
      this.process.once("close", finish);
      terminateTimer = setTimeout(() => {
        if (!this.processClosed) this.process.kill("SIGKILL");
      }, 4_000);
      lastResortTimer = setTimeout(finish, 8_000);
      if (this.process.exitCode === null && this.process.signalCode === null) {
        try { this.process.kill(); }
        catch { finish(); }
      }
    });
    return this.stopPromise;
  }
}

export const keyEvent = (key: string, down: boolean) => ({
  type: "key",
  data: { down, key: { type: "qcode", data: key } },
});

export function textKeyEvents(character: string): Array<ReturnType<typeof keyEvent>> {
  // qcodes are physical keys. Shift is held only for the required characters.
  const shifted = "~!@#$%^&*()_+{}|:\"<>?";
  const shiftedBase = "`1234567890-=[]\\;',./";
  let key = character.toLowerCase();
  let shift = character !== character.toLowerCase() && /^[A-Z]$/u.test(character);
  const offset = shifted.indexOf(character);
  if (offset >= 0) {
    key = shiftedBase[offset] ?? key;
    shift = true;
  }
  const map: Record<string, string> = {
    " ": "spc", "\n": "ret", "\t": "tab", "-": "minus", "=": "equal", "[": "bracket_left",
    "]": "bracket_right", "\\": "backslash", ";": "semicolon", "'": "apostrophe",
    ",": "comma", ".": "dot", "/": "slash", "`": "grave_accent",
  };
  const qcode = map[key] ?? key;
  if (!/^[a-z0-9]$/u.test(key) && !(key in map)) {
    throw new Error("This character cannot be typed into the box yet.");
  }
  return [
    ...(shift ? [keyEvent("shift", true)] : []),
    keyEvent(qcode, true),
    keyEvent(qcode, false),
    ...(shift ? [keyEvent("shift", false)] : []),
  ];
}
