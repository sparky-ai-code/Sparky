import { spawn } from "node:child_process";
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
  if (!/^https?:\/\//u.test(config.url)) {
    throw new Error(`MCP server ${config.name} must configure either an HTTP URL or local command.`);
  }
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (config.authorizationToken) headers.authorization = `Bearer ${config.authorizationToken}`;
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

async function callStdioMcp(
  config: McpServerConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  if (!config.command) throw new Error(`MCP server ${config.name} has no command configured.`);
  const child = spawn(config.command, config.args, { shell: false, stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  let nextId = 0;
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  const timeout = setTimeout(() => child.kill(), 20_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    if (buffer.length > 1_000_000) {
      child.kill();
      return;
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line) as JsonRpcResponse & { id?: number };
        if (typeof response.id === "number") pending.get(response.id)?.(response);
      } catch {
        // Ignore non-protocol stdout lines from an incorrectly configured command.
      }
    }
  });
  try {
    const request = (rpcMethod: string, rpcParams?: Record<string, unknown>) =>
      new Promise<JsonRpcResponse>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, (response) => {
          pending.delete(id);
          if (response.error) reject(new Error(response.error.message ?? `MCP method ${rpcMethod} failed.`));
          else resolve(response);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: rpcMethod, params: rpcParams ?? {} })}\n`);
      });
    const failPending = (message: string) => {
      for (const resolve of pending.values()) resolve({ error: { message } });
      pending.clear();
    };
    child.once("error", (error) => failPending(error.message));
    child.stdin.on("error", (error) => failPending(error.message));
    child.once("exit", (code) => {
      failPending(`MCP process exited before replying (code ${code ?? "unknown"}).`);
    });
    await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "Sparky", version: "1.0.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const response = await request(method, params);
    return response;
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

export async function listExternalMcpTools(config: McpServerConfig): Promise<unknown> {
  if (config.command) {
    const { result } = await callStdioMcp(config, "tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }
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
  if (config.command) {
    const { result } = await callStdioMcp(config, "tools/call", {
      name: toolName,
      arguments: arguments_,
    });
    return result ?? null;
  }
  const sessionId = await initialize(config);
  const { response } = await send(config, sessionId, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: toolName, arguments: arguments_ },
  });
  return response?.result ?? null;
}
