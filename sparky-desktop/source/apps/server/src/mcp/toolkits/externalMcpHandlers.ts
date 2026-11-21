// @effect-diagnostics cryptoRandomUUIDInEffect:off
import * as Effect from "effect/Effect";

import * as ServerSettings from "../../serverSettings.ts";
import type { McpServerConfig } from "@sparky/contracts";
import { callExternalMcpTool, listExternalMcpTools } from "../ExternalMcp.ts";
import { ExternalMcpToolkit } from "./externalMcpTools.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The handlers read and write settings through the service captured when the layer
// is built. A settings failure is a defect, because these tools declare no failure
// channel of their own.
export const ExternalMcpToolkitHandlersLive = ExternalMcpToolkit.toLayer(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const readSettings = settings.getSettings.pipe(Effect.orDie);
    const updateSettings = (patch: Parameters<typeof settings.updateSettings>[0]) =>
      settings.updateSettings(patch).pipe(Effect.orDie);

    return {
      sparky_mcp_setup_server: (input: {
        readonly name: string;
        readonly url: string;
        readonly authorizationToken?: string | undefined;
      }) =>
        Effect.gen(function* () {
          const current = yield* readSettings;
          const name = input.name.trim();
          if (!name) return { error: "Enter a name for the MCP server." };
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(input.url);
          } catch {
            return { error: "Enter a valid HTTP or HTTPS MCP server URL." };
          }
          if (
            !["http:", "https:"].includes(parsedUrl.protocol) ||
            parsedUrl.username ||
            parsedUrl.password
          ) {
            return {
              error: "MCP server URLs must use HTTP or HTTPS and cannot embed credentials.",
            };
          }
          if (
            current.mcpServers.some((server) => server.name.toLowerCase() === name.toLowerCase())
          ) {
            return { error: `An MCP server named '${name}' is already configured.` };
          }
          const server: McpServerConfig = {
            id: crypto.randomUUID(),
            name,
            url: parsedUrl.toString(),
            authorizationToken: input.authorizationToken ?? "",
            authorizationTokenRedacted: false,
            enabled: true,
          };
          const tools = yield* Effect.tryPromise({
            try: () => listExternalMcpTools(server),
            catch: (error) => message(error),
          }).pipe(
            Effect.catch((error) => Effect.succeed({ error: error || "MCP connection failed." })),
          );
          if (!Array.isArray(tools)) return tools;
          yield* updateSettings({ mcpServers: [...current.mcpServers, server] });
          return {
            configured: true,
            serverName: name,
            toolCount: tools.length,
            tools: tools.map((tool) =>
              typeof tool === "object" && tool !== null && "name" in tool
                ? String(tool.name)
                : "(unnamed tool)",
            ),
          };
        }),
      sparky_mcp_list_tools: (input: { readonly serverName?: string | undefined }) =>
        Effect.gen(function* () {
          const configured = (yield* readSettings).mcpServers.filter((server) => server.enabled);
          const selected = input.serverName
            ? configured.filter((server) => server.name === input.serverName)
            : configured;
          return yield* Effect.forEach(
            selected,
            (server) =>
              Effect.tryPromise({
                try: () => listExternalMcpTools(server),
                catch: (error) => message(error),
              }).pipe(
                Effect.map((tools) => ({ serverName: server.name, tools })),
                Effect.catch((error) => Effect.succeed({ serverName: server.name, error })),
              ),
            { concurrency: 4 },
          );
        }),
      sparky_mcp_call_tool: (input: {
        readonly serverName: string;
        readonly toolName: string;
        readonly arguments: Record<string, unknown>;
      }) =>
        Effect.gen(function* () {
          const server = (yield* readSettings).mcpServers.find(
            (candidate) => candidate.enabled && candidate.name === input.serverName,
          );
          if (!server)
            return { error: `MCP server '${input.serverName}' is not configured or enabled.` };
          return yield* Effect.tryPromise({
            try: () => callExternalMcpTool(server, input.toolName, input.arguments),
            catch: (error) => message(error),
          }).pipe(Effect.catch((error) => Effect.succeed({ error })));
        }),
    };
  }),
);
