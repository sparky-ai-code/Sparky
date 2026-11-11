import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Microboxes from "../../../microboxes/Microboxes.ts";
import { MicroboxesToolkit } from "./tools.ts";

// The agent cannot choose another thread ID; it is derived from the authenticated MCP session.
const withScope = Effect.fn("MicroboxesToolkit.withScope")(function* <A>(
  execute: (service: Microboxes.MicroboxesService, threadId: import("@sparky/contracts").ThreadId) => Effect.Effect<A, import("@sparky/contracts").MicroboxError>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const service = yield* Microboxes.Microboxes;
  return yield* execute(service, scope.threadId);
});

export const MicroboxesToolkitHandlersLive = MicroboxesToolkit.toLayer({
  box_images: () => withScope((service) => service.images),
  box_list: () => withScope((service, threadId) => service.list(threadId)),
  box_create: (input) => Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const service = yield* Microboxes.Microboxes;
    return yield* service.create({ threadId: scope.threadId, ...input }, scope.cwd);
  }),
  box_status: (input) => withScope((service, threadId) => service.status({ threadId, ...input })),
  box_snapshot: (input) => withScope((service, threadId) => service.snapshot({ threadId, ...input })),
  box_click: (input) => withScope((service, threadId) =>
    service.click({ threadId, ...input }).pipe(Effect.as(null))),
  box_type: (input) => withScope((service, threadId) =>
    service.type({ threadId, ...input }).pipe(Effect.as(null))),
  box_press: (input) => withScope((service, threadId) =>
    service.press({ threadId, ...input }).pipe(Effect.as(null))),
  box_stop: (input) => withScope((service, threadId) =>
    service.stop({ threadId, ...input }).pipe(Effect.as(null))),
  box_destroy: (input) => withScope((service, threadId) =>
    service.destroy({ threadId, ...input }).pipe(Effect.as(null))),
});
