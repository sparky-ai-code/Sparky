import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { callPluginWorkerTool } from "../../../plugins/workerSession.ts";
import { PluginToolkit } from "./tools.ts";

const currentInvocation = McpInvocationContext.McpInvocationContext as unknown as Effect.Effect<
  McpInvocationContext.McpInvocationScope,
  never,
  never
>;

const handlers = {
  sparky_request_plugin_authorization: (input) =>
    Effect.gen(function* () {
      const invocation = yield* currentInvocation;
      return yield* callPluginWorkerTool(
        "sparky_request_plugin_authorization",
        input,
        invocation.pluginSessionToken,
      );
    }).pipe(
      Effect.catch((error) => Effect.succeed({ status: "unavailable", message: error.detail })),
    ),
  sparky_plugin_call: (input) =>
    Effect.gen(function* () {
      const invocation = yield* currentInvocation;
      return yield* callPluginWorkerTool(
        "sparky_plugin_call",
        input,
        invocation.pluginSessionToken,
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ error: error.detail, pluginId: input.pluginId, action: input.action }),
      ),
    ),
} satisfies Parameters<typeof PluginToolkit.toLayer>[0];

export const PluginToolkitHandlersLive = PluginToolkit.toLayer(handlers);
