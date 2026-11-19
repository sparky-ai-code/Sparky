import { expect, it } from "@effect/vitest";

import { callExternalMcpTool, listExternalMcpTools } from "./ExternalMcp.ts";

const config = {
  id: "stdio-test",
  name: "stdio test server",
  transport: "stdio",
  url: "",
  command: process.execPath,
  args: [
    "-e",
    `process.stdin.setEncoding("utf8"); let buffer = ""; process.stdin.on("data", chunk => { buffer += chunk; for (;;) { const end = buffer.indexOf("\\n"); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); const request = JSON.parse(line); if (request.id === undefined) continue; const result = request.method === "tools/list" ? { tools: [{ name: "hello" }] } : request.method === "tools/call" ? { content: [{ type: "text", text: "called" }] } : { protocolVersion: "2025-03-26", capabilities: {} }; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n"); } });`,
  ],
  env: {},
  authorizationToken: "",
  authorizationTokenRedacted: false,
  enabled: true,
} as const;

it("discovers and calls tools on local stdio MCP servers", async () => {
  expect(await listExternalMcpTools(config)).toEqual([{ name: "hello" }]);
  expect(await callExternalMcpTool(config, "hello", {})).toEqual({
    content: [{ type: "text", text: "called" }],
  });
});
