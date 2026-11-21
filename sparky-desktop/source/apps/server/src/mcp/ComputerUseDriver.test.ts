import { expect, it } from "@effect/vitest";

import { makeComputerUseDriver } from "./ComputerUseDriver.ts";

// A tiny fake newline-delimited JSON-RPC MCP server. Like the real `cua-driver`,
// it handles one request at a time. `arguments.ms` makes a call take that long;
// a call named "hang" never answers.
const fakeServer = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let chain = Promise.resolve();
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  chain = chain.then(async () => {
    if (m.method === "tools/call" && m.params.name === "hang") return new Promise(() => {});
    let result = {};
    if (m.method === "tools/list") result = { tools: [{ name: "screenshot" }] };
    if (m.method === "tools/call") {
      await delay(Number(m.params.arguments?.ms ?? 0));
      result = { echoed: m.params };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  });
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
    await expect(driver.listTools()).rejects.toThrow(
      /Could not start computer-use driver: Cua Driver is missing \('definitely-not-a-real-cua-driver' was not found\)/,
    );
  } finally {
    driver.close();
  }
});

it("times each call from when the driver starts it, not when it was queued", async () => {
  // Each call takes 200ms of driver time and the limit is 300ms. The second call
  // waits 200ms in the driver's queue, so it only passes if its clock starts late.
  const driver = makeComputerUseDriver({
    command: process.execPath,
    args: ["-e", fakeServer],
    requestTimeoutMs: 300,
  });
  try {
    await driver.listTools();
    const results = await Promise.all([
      driver.callTool("click", { ms: 200 }),
      driver.callTool("click", { ms: 200 }),
    ]);
    expect(results).toHaveLength(2);
  } finally {
    driver.close();
  }
});

it("restarts a wedged driver so later calls recover", async () => {
  const driver = makeComputerUseDriver({
    command: process.execPath,
    args: ["-e", fakeServer],
    requestTimeoutMs: 200,
  });
  try {
    await expect(driver.callTool("hang", {})).rejects.toThrow(/timed out.*restarted/);
    expect(await driver.callTool("click", { x: 2 })).toEqual({
      echoed: { name: "click", arguments: { x: 2 } },
    });
  } finally {
    driver.close();
  }
});

it("gives slow discovery tools a longer budget than the default", async () => {
  // The default limit also covers the initialize handshake, which includes a cold
  // Node start, so it is kept well above that to avoid flaking on slow machines.
  // The list_apps call takes longer than the default but fits in its own budget.
  const driver = makeComputerUseDriver({
    command: process.execPath,
    args: ["-e", fakeServer],
    requestTimeoutMs: 1_000,
    toolTimeoutsMs: { list_apps: 5_000 },
  });
  try {
    expect(await driver.callTool("list_apps", { ms: 1_500 })).toEqual({
      echoed: { name: "list_apps", arguments: { ms: 1_500 } },
    });
  } finally {
    driver.close();
  }
});
