import * as Effect from "effect/Effect";

import * as ServerSettings from "../../serverSettings.ts";
import { callExternalMcpTool, listExternalMcpTools } from "../ExternalMcp.ts";
import { callBlenderMcpTool, listBlenderMcpTools } from "../BlenderMcp.ts";
import { ExternalMcpToolkit } from "./externalMcpTools.ts";

const handlers = {
  sparky_mcp_list_tools: (input) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const allSettings = yield* settings.getSettings;
      const configured = allSettings.mcpServers.filter((server) => server.enabled);
      const selected = input.serverName
        ? configured.filter((server) => server.name === input.serverName)
        : configured;
      const results = yield* Effect.forEach(
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
      if (
        allSettings.blenderMcp.enabled &&
        (!input.serverName || input.serverName === "Blender MCP")
      ) {
        const blenderResult = yield* Effect.tryPromise({
          try: () => listBlenderMcpTools(allSettings.blenderMcp),
          catch: (error) => error,
        }).pipe(
          Effect.map((tools) => ({ serverName: "Blender MCP", tools })),
          Effect.catch((error) =>
            Effect.succeed({
              serverName: "Blender MCP",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
        return [...results, blenderResult];
      }
      return results;
    }),
  sparky_mcp_call_tool: (input) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const allSettings = yield* settings.getSettings;
      if (input.serverName === "Blender MCP" && allSettings.blenderMcp.enabled) {
        return yield* Effect.tryPromise({
          try: () => callBlenderMcpTool(allSettings.blenderMcp, input.toolName, input.arguments),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({ error: error instanceof Error ? error.message : String(error) }),
          ),
        );
      }
      const server = allSettings.mcpServers.find(
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
