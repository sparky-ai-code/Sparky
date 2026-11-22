import { Tool } from "effect/unstable/ai";

export type McpInputSchema = Record<string, unknown> & { readonly type: "object" };

/**
 * MCP clients and model providers require a tool's input schema to be a JSON
 * object schema at the top level. Effect emits `Schema.Struct({})` (a tool
 * that takes no arguments) as `{ anyOf: [{ type: "object" }, { type: "array" }] }`
 * with no top-level `type`, which providers reject with
 * "schema must be a JSON Schema of 'type: \"object\"'".
 */
export const getMcpInputSchema = (tool: Tool.Any): McpInputSchema => {
  const schema = Tool.getJsonSchema(tool) as Record<string, unknown>;
  if (schema.type === "object") {
    return schema as McpInputSchema;
  }
  if (Array.isArray(schema.anyOf) && schema.properties === undefined) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return schema as McpInputSchema;
};
