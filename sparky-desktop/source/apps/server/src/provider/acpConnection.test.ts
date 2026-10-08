// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { AcpConnection } from "./acpConnection.ts";

const command = (source: string) => ({
  command: NodeProcess.execPath,
  args: ["-e", source],
  shell: false,
});
const cwd = NodeProcess.cwd();

describe("ACP JSON-RPC transport", () => {
  it("correlates newline-delimited requests", async () => {
    const connection = new AcpConnection(
      command(
        [
          "const readline = require('node:readline');",
          "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
          "const message = JSON.parse(line);",
          "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { method: message.method } }) + '\\n');",
          "});",
        ].join("\n"),
      ),
      cwd,
      NodeProcess.env,
    );
    try {
      await expect(connection.request("initialize", {})).resolves.toEqual({ method: "initialize" });
    } finally {
      connection.close();
    }
  });

  it("rejects pending requests when the harness exits", async () => {
    const connection = new AcpConnection(
      command("process.stdin.resume(); setTimeout(() => process.exit(1), 30);"),
      cwd,
      NodeProcess.env,
    );
    try {
      await expect(connection.request("initialize", {}, 2_000)).rejects.toThrow(
        "ACP harness exited",
      );
    } finally {
      connection.close();
    }
  });

  it("terminates descendant processes when the connection closes", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sparky-acp-"));
    const marker = NodePath.join(directory, "survived");
    const grandchildScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1000);`;
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'spawned' }) + '\\n');",
      "process.stdin.resume();",
    ].join("\n");
    const connection = new AcpConnection(command(parentScript), cwd, NodeProcess.env);
    try {
      await new Promise<void>((resolve) => {
        connection.onNotification = (method) => {
          if (method === "spawned") resolve();
        };
      });
      const parentClosed = new Promise<void>((resolve) =>
        connection.child.once("close", () => resolve()),
      );
      connection.close();
      await parentClosed;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(NodeFS.existsSync(marker)).toBe(false);
    } finally {
      connection.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
