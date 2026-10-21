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

export const ExternalMcpToolkit = Toolkit.make(McpListTools, McpCallTool);
