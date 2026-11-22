import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import { getMcpInputSchema } from "./toolInputSchema.ts";

const makeTool = (name: string, parameters: Schema.Top) =>
  Tool.make(name, {
    description: "test tool",
    parameters: parameters as Schema.Struct<any>,
    success: Schema.Unknown,
    failure: Schema.Never,
  });

describe("getMcpInputSchema", () => {
  it("emits a top-level object schema for tools that take no arguments", () => {
    const schema = getMcpInputSchema(makeTool("no_args", Schema.Struct({})));

    expect(schema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("keeps the generated object schema for tools with arguments", () => {
    const schema = getMcpInputSchema(
      makeTool("with_args", Schema.Struct({ threadId: Schema.String })),
    );

    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({ threadId: { type: "string" } });
    expect(schema.required).toEqual(["threadId"]);
  });
});
