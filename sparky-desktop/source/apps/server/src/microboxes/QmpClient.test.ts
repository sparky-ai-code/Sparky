import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

import { QmpClient, keyEvent, textKeyEvents } from "./QmpClient.ts";

function simulateMachine() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;

  const commands: Array<{ execute: string; id: string; arguments?: Record<string, unknown> }> = [];
  process.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const command = JSON.parse(line) as {
        execute: string; id: string; arguments?: Record<string, unknown>;
      };
      commands.push(command);
      process.stdout.write(JSON.stringify({ id: command.id, return: {} }) + "\n");
    }
  });
  const qmp = new QmpClient(process);
  process.stdout.write(JSON.stringify({ QMP: { version: {}, capabilities: [] } }) + "\n");
  return { qmp, process, commands };
}

describe("Microboxes QMP monitor", () => {
  it("completes the capability handshake and correctly correlates commands", async () => {
    const { qmp, commands } = simulateMachine();
    await qmp.ready;
    await qmp.command("screendump", { filename: "/tmp/screen.png", format: "png" });
    expect(commands.map((command) => command.execute)).toEqual([
      "qmp_capabilities", "screendump",
    ]);
    expect(commands[1]?.arguments).toEqual({
      filename: "/tmp/screen.png", format: "png",
    });
  });

  it("rejects commands when the guest process exits", async () => {
    const { qmp, process } = simulateMachine();
    await qmp.ready;
    process.emit("exit", 1);
    await expect(qmp.command("query-status")).rejects.toThrow("not running");
  });

  it("encodes physical keyboard keys with balanced key-down/up events", () => {
    expect(keyEvent("a", true)).toEqual({
      type: "key", data: { down: true, key: { type: "qcode", data: "a" } },
    });
    expect(textKeyEvents("A").map((entry) => [
      entry.data.key.data, entry.data.down,
    ])).toEqual([
      ["shift", true], ["a", true], ["a", false], ["shift", false],
    ]);
    expect(textKeyEvents("?").map((entry) => entry.data.key.data)).toEqual([
      "shift", "slash", "slash", "shift",
    ]);
  });

  it("does not try to synthesize unsupported Unicode as physical keys", () => {
    expect(() => textKeyEvents("🚀")).toThrow("cannot be typed");
  });
});
