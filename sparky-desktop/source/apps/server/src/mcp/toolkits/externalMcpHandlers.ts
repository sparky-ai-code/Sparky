import * as Effect from "effect/Effect";

import * as ServerSettings from "../../serverSettings.ts";
import type { McpServerConfig } from "@sparky/contracts";
import { callExternalMcpTool, listExternalMcpTools } from "../ExternalMcp.ts";
import { ExternalMcpToolkit } from "./externalMcpTools.ts";

const handlers = {
  sparky_mcp_setup_server: (input) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const current = yield* settings.getSettings;
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
        return { error: "MCP server URLs must use HTTP or HTTPS and cannot embed credentials." };
      }
      if (current.mcpServers.some((server) => server.name.toLowerCase() === name.toLowerCase())) {
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
        catch: () => new Error("MCP connection failed."),
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ error: error instanceof Error ? error.message : "MCP connection failed." }),
        ),
      );
      if (!Array.isArray(tools)) return tools;
      yield* settings.updateSettings({ mcpServers: [...current.mcpServers, server] });
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
  sparky_mcp_list_tools: (input) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const configured = (yield* settings.getSettings).mcpServers.filter((server) => server.enabled);
      const selected = input.serverName
        ? configured.filter((server) => server.name === input.serverName)
        : configured;
      return yield* Effect.forEach(
        selected,
        (server) =>
          Effect.tryPromise({
            try: () => listExternalMcpTools(server),
            catch: (error) => error,
          }).pipe(
            Effect.map((tools) => ({ serverName: server.name, tools })),
            Effect.catch((error) =>
              Effect.succeed({
                serverName: server.name,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        { concurrency: 4 },
      );
    }),
  sparky_mcp_call_tool: (input) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const server = (yield* settings.getSettings).mcpServers.find(
        (candidate) => candidate.enabled && candidate.name === input.serverName,
      );
      if (!server) return { error: `MCP server '${input.serverName}' is not configured or enabled.` };
      return yield* Effect.tryPromise({
        try: () => callExternalMcpTool(server, input.toolName, input.arguments),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ error: error instanceof Error ? error.message : String(error) }),
        ),
      );
    }),
} satisfies Parameters<typeof ExternalMcpToolkit.toLayer>[0];

export const ExternalMcpToolkitHandlersLive = ExternalMcpToolkit.toLayer(handlers);
