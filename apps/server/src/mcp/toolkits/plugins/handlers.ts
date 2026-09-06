import * as Effect from "effect/Effect";

import { callPluginWorkerTool } from "../../../plugins/workerSession.ts";
import { PluginToolkit } from "./tools.ts";

const handlers = {
  sparky_request_plugin_authorization: (input) =>
    callPluginWorkerTool("sparky_request_plugin_authorization", input).pipe(
      Effect.catch((error) => Effect.succeed({ status: "unavailable", message: error.detail })),
    ),
  sparky_plugin_call: (input) =>
    callPluginWorkerTool("sparky_plugin_call", input).pipe(
      Effect.catch((error) =>
        Effect.succeed({ error: error.detail, pluginId: input.pluginId, action: input.action }),
      ),
    ),
} satisfies Parameters<typeof PluginToolkit.toLayer>[0];

export const PluginToolkitHandlersLive = PluginToolkit.toLayer(handlers);
