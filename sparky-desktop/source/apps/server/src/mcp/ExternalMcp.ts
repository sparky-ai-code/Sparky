import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";

import type { McpServerConfig } from "@sparky/contracts";

type JsonRpcResponse = {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
};


class ExternalMcpProtocolError extends Data.TaggedError("ExternalMcpProtocolError")<{
  readonly message: string;
}> {}

/** Return the first complete SSE event carrying data (skipping heartbeats). */
export function firstSseData(buffer: string): string | null {
  const events = buffer.split(/\r?\n\r?\n/u);
  for (const event of events.slice(0, -1)) {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data) return data;
  }
  return null;
}

function readSseData<E, R>(body: Stream.Stream<Uint8Array, E, R>) {
  const decoder = new TextDecoder();
  return body.pipe(
    Stream.map((chunk) => decoder.decode(chunk, { stream: true })),
    Stream.scan("", (buffer, chunk) => buffer + chunk),
    Stream.filter((buffer) => firstSseData(buffer) !== null),
    Stream.runHead,
    Effect.flatMap((result) => {
      const data = Option.isSome(result) ? firstSseData(result.value) : null;
      return data
        ? Effect.succeed(data)
        : Effect.fail(new ExternalMcpProtocolError({
            message: "MCP server event stream did not contain a response.",
          }));
    }),
  );
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
  if (config.authorizationToken) headers.authorization = `Bearer ${config.authorizationToken}`;

  // A scoped Effect HTTP client supports streaming responses and cancellation
  // without relying on a global fetch or manual reader lifetime management.
  return Effect.runPromise(
    Effect.gen(function* () {
      const request = HttpClientRequest.post(config.url).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyText(JSON.stringify(payload), "application/json"),
      );
      const response = yield* HttpClient.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(new ExternalMcpProtocolError({
          message: `MCP server ${config.name} returned HTTP ${response.status}.`,
        }));
      }
      const nextSessionId = response.headers["mcp-session-id"] ?? sessionId;
      if (response.status === 202 || response.status === 204) {
        return { response: null, ...(nextSessionId ? { sessionId: nextSessionId } : {}) };
      }
      const body = response.headers["content-type"]?.includes("text/event-stream")
        ? yield* readSseData(response.stream)
        : yield* response.text;
      if (!body) {
        return yield* Effect.fail(new ExternalMcpProtocolError({
          message: `MCP server ${config.name} returned an empty response.`,
        }));
      }
      const parsed = yield* Effect.try({
        try: () => JSON.parse(body) as JsonRpcResponse,
        catch: () => new ExternalMcpProtocolError({
          message: `MCP server ${config.name} returned an invalid JSON-RPC response.`,
        }),
      });
      if (parsed.error) {
        return yield* Effect.fail(new ExternalMcpProtocolError({
          message: parsed.error.message ?? `MCP server ${config.name} returned an error.`,
        }));
      }
      return { response: parsed, ...(nextSessionId ? { sessionId: nextSessionId } : {}) };
    }).pipe(
      Effect.timeout("20 seconds"),
      Effect.provide(NodeHttpClient.layerNodeHttp),
    ),
  );
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
