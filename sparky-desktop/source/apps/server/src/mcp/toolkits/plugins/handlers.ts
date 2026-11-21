import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { callPluginWorkerTool } from "../../../plugins/workerSession.ts";
import { PluginToolkit } from "./tools.ts";

const currentInvocation = McpInvocationContext.McpInvocationContext as unknown as Effect.Effect<
  McpInvocationContext.McpInvocationScope,
  never,
  never
>;

// The broker is captured when the layer is built, so the handlers declare no
// requirements of their own.
export const PluginToolkitHandlersLive = PluginToolkit.toLayer(
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    return {
      sparky_request_plugin_authorization: (input: { readonly pluginId: string }) =>
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
      getPullRequestComments: (input: Record<string, unknown>) =>
        Effect.gen(function* () {
          const invocation = yield* currentInvocation;
          const result = yield* broker.invoke<{
            comments: unknown[];
            error: string | null;
          }>({
            scope: invocation,
            operation: "githubPullRequestComments",
            input,
            timeoutMs: 30_000,
          });
          return result.error ? { comments: [], error: result.error } : result;
        }).pipe(Effect.catch((error) => Effect.succeed({ comments: [], error: error.message }))),
      sparky_plugin_call: (input: { readonly pluginId: string; readonly action: string }) =>
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
    };
  }),
);
