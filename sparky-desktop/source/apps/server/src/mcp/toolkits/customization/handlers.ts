import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { readCustomization, writeCustomization } from "../../../customizationStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ApplyCustomizationTool, ReadCustomizationTool } from "./tools.ts";

type Invocation = McpInvocationContext.McpInvocationScope;
type Invoke = (payload: unknown, scope: Invocation) => Effect.Effect<unknown, Error>;

class CustomizationToolError extends Data.TaggedError("CustomizationToolError")<{ readonly message: string }> {}

const result = (value: unknown, isError: boolean): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError,
    structuredContent: isError ? { error: String(value) } : { result: value },
    content: [{ type: "text", text: isError ? String(value) : JSON.stringify(value) }],
  });

export const registerCustomizationTools = Effect.fn("McpCustomizationTools.register")(function* () {
  const server = yield* McpServer.McpServer;
  const config = yield* ServerConfig.ServerConfig;
  const projection = yield* ProjectionSnapshotQuery;

  // Resolve these services while the MCP layer is being constructed. Tools
  // must not require extra Effect context at invocation time: the MCP request
  // layer only injects the authenticated invocation scope.
  const read: Invoke = () => Effect.sync(() => readCustomization(config.stateDir));
  const apply: Invoke = (payload, scope) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(ApplyCustomizationTool.parametersSchema)(payload);
      const source = Option.getOrNull(yield* projection.getThreadShellById(scope.threadId));
      if (!source || source.runtimeMode !== "full-access" || source.interactionMode === "plan") {
        return yield* Effect.fail(new CustomizationToolError({ message: "Customizing the app requires an active thread in Full access mode." }));
      }
      return yield* Effect.try({
        try: () => writeCustomization(config.stateDir, input.customization, input.expectedRevision),
        catch: (cause) => new CustomizationToolError({ message: cause instanceof Error ? cause.message : "Could not save customization." }),
      });
    });

  const register = (tool: Tool.Any, invoke: Invoke) =>
    server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const scope = Context.getUnsafe(fiber.context, McpInvocationContext.McpInvocationContext);
          return invoke(payload, scope).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) => {
                const error = Cause.squash(cause);
                return Effect.succeed(result(error instanceof Error ? error.message : String(error), true));
              },
              onSuccess: (value) => Effect.succeed(result(value, false)),
            }),
          );
        }),
    });

  yield* register(ReadCustomizationTool, read);
  yield* register(ApplyCustomizationTool, apply);
});
