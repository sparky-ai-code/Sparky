import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { annotateEnvironmentRequest, failEnvironmentScopeRequired } from "../auth/http.ts";
import { normalizePluginSessionToken } from "./workerSession.ts";

export const pluginSessionHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "plugins",
  Effect.fnUntraced(function* (handlers) {
    return handlers.handle(
      "syncSession",
      Effect.fn("environment.plugins.syncSession")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const principal = yield* EnvironmentAuthenticatedPrincipal;
        if (!principal.scopes.has(AuthOrchestrationOperateScope)) {
          return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
        }
        const token = normalizePluginSessionToken(args.payload.sessionToken);
        const ready = yield* McpSessionRegistry.setActivePluginSession(principal.sessionId, token);
        return { ready };
      }),
    );
  }),
);
