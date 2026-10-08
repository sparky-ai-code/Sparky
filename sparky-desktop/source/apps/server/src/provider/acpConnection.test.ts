import { describe, expect, it } from "vite-plus/test";
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
});
