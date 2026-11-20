import { expect, it } from "@effect/vitest";

import { makeComputerUseDriver } from "./ComputerUseDriver.ts";

// A tiny fake newline-delimited JSON-RPC MCP server.
const fakeServer = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "tools/list") result = { tools: [{ name: "screenshot" }] };
  if (m.method === "tools/call") result = { echoed: m.params };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`;

it("lists and calls tools over one long-lived stdio process", async () => {
  const driver = makeComputerUseDriver({
    command: process.execPath,
    args: ["-e", fakeServer],
  });
  try {
    expect(await driver.listTools()).toEqual([{ name: "screenshot" }]);
    expect(await driver.callTool("click", { x: 1 })).toEqual({
      echoed: { name: "click", arguments: { x: 1 } },
    });
  } finally {
    driver.close();
  }
});

it("reports a clear error when the driver binary is missing", async () => {
  const driver = makeComputerUseDriver({ command: "definitely-not-a-real-cua-driver" });
  try {
    await expect(driver.listTools()).rejects.toThrow(/Could not start computer-use driver/);
  } finally {
    driver.close();
  }
});
