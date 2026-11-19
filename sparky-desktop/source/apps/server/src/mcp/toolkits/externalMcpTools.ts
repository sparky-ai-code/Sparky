import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

export const McpListTools = Tool.make("sparky_mcp_list_tools", {
  description:
    "List the tools exposed by MCP servers configured in Sparky settings. Call this before using a configured external MCP server.",
  parameters: Schema.Struct({ serverName: Schema.optional(Schema.String) }),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "List configured MCP tools")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false);

export const McpSetupServer = Tool.make("sparky_mcp_setup_server", {
  description:
    "Set up a streamable HTTP MCP server for the user: validate the URL, connect and discover its tools, then save it in Sparky settings. Only do this when the user asks to configure the server. The bearer token is stored as a secret and must never be repeated in the response.",
  parameters: Schema.Struct({
    name: Schema.String,
    url: Schema.String,
    authorizationToken: Schema.optional(Schema.String),
  }),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "Set up MCP server")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const McpCallTool = Tool.make("sparky_mcp_call_tool", {
  description:
    "Call a tool on an MCP server configured in Sparky settings. Use sparky_mcp_list_tools first to get the exact server and tool names.",
  parameters: Schema.Struct({
    serverName: Schema.String,
    toolName: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
  }),
  success: Schema.Unknown,
  failure: Schema.Never,
})
  .annotate(Tool.Title, "Call configured MCP tool")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const ExternalMcpToolkit = Toolkit.make(McpSetupServer, McpListTools, McpCallTool);
