import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, failEnvironmentScopeRequired } from "../auth/http.ts";
import { hasPluginSessionToken, setPluginSessionToken } from "./workerSession.ts";

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
        setPluginSessionToken(args.payload.sessionToken);
        return { ready: hasPluginSessionToken() };
      }),
    );
  }),
);
