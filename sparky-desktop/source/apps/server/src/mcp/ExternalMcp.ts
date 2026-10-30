import type { McpServerConfig } from "@sparky/contracts";

type JsonRpcResponse = {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
};

async function readSseData(response: Response): Promise<string> {
  if (!response.body) throw new Error("MCP server returned an empty event stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const boundary = buffer.search(/\r?\n\r?\n/u);
      if (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        const data = event
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data) return data;
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/u, "");
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error("MCP server event stream did not contain a response.");
}

async function send(
  config: McpServerConfig,
  sessionId: string | undefined,
  payload: Record<string, unknown>,
): Promise<{ readonly response: JsonRpcResponse | null; readonly sessionId?: string }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (config.authorizationToken) {
    headers[config.authorizationHeaderName] =
      config.authorizationHeaderName.toLowerCase() === "authorization"
        ? `Bearer ${config.authorizationToken}`
        : config.authorizationToken;
  }
  const response = await fetch(config.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`MCP server ${config.name} returned HTTP ${response.status}.`);
  }
  const nextSessionId = response.headers.get("mcp-session-id") ?? sessionId;
  if (response.status === 202 || response.status === 204) {
    return { response: null, ...(nextSessionId ? { sessionId: nextSessionId } : {}) };
  }
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? await readSseData(response)
    : await response.text();
  if (!data) throw new Error(`MCP server ${config.name} returned an empty response.`);
  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(data) as JsonRpcResponse;
  } catch {
    throw new Error(`MCP server ${config.name} returned an invalid JSON-RPC response.`);
  }
  if (parsed.error) throw new Error(parsed.error.message ?? `MCP server ${config.name} returned an error.`);
  return { response: parsed, ...(nextSessionId ? { sessionId: nextSessionId } : {}) };
}

async function initialize(config: McpServerConfig): Promise<string | undefined> {
  const initialized = await send(config, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "Sparky", version: "1.0.0" },
    },
  });
  await send(config, initialized.sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  return initialized.sessionId;
}

export async function listExternalMcpTools(config: McpServerConfig): Promise<unknown> {
  const sessionId = await initialize(config);
  const tools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const { response } = await send(config, sessionId, {
      jsonrpc: "2.0",
      id: page + 2,
      method: "tools/list",
      params: cursor ? { cursor } : {},
    });
    const result = response?.result;
    if (Array.isArray(result?.tools)) tools.push(...result.tools);
    if (typeof result?.nextCursor !== "string" || !result.nextCursor) return tools;
    cursor = result.nextCursor;
  }
  throw new Error(`MCP server ${config.name} returned too many tool pages.`);
}

export async function callExternalMcpTool(
  config: McpServerConfig,
  toolName: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const sessionId = await initialize(config);
  const { response } = await send(config, sessionId, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: toolName, arguments: arguments_ },
  });
  return response?.result ?? null;
}
