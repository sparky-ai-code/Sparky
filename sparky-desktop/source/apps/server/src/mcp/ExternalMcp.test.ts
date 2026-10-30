import { expect, it } from "@effect/vitest";
import type { McpServerConfig } from "@sparky/contracts";

import { listExternalMcpTools } from "./ExternalMcp.ts";

const config = (authorizationHeaderName: string): McpServerConfig => ({
  id: "test-server",
  name: "Test server",
  url: "https://example.test/mcp",
  authorizationHeaderName,
  authorizationToken: "secret-value",
  authorizationTokenRedacted: false,
  enabled: true,
});

it("sends custom authentication headers for external MCP servers", async () => {
  const originalFetch = globalThis.fetch;
  const requestHeaders: Headers[] = [];
  globalThis.fetch = async (_input, init) => {
    requestHeaders.push(new Headers(init?.headers));
    const body = JSON.parse(String(init?.body)) as { readonly method: string };
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26" } : { tools: [] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await listExternalMcpTools(config("X-Goog-Api-Key"));
    expect(requestHeaders).toHaveLength(3);
    expect(requestHeaders[0]?.get("x-goog-api-key")).toBe("secret-value");
    expect(requestHeaders[0]?.get("authorization")).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("keeps bearer authentication for the default Authorization header", async () => {
  const originalFetch = globalThis.fetch;
  let authorization: string | null = null;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    const body = JSON.parse(String(init?.body)) as { readonly method: string };
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26" } : { tools: [] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await listExternalMcpTools(config("Authorization"));
    expect(authorization).toBe("Bearer secret-value");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
