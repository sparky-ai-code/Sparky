import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServerConfig from "../../../config.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readCustomization, writeCustomization } from "../../../customizationStore.ts";
import { CustomizationToolkit } from "./tools.ts";

const handlers = {
  sparky_customization_read: () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return readCustomization(config.stateDir);
    }),
  sparky_customization_apply: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const projection = yield* ProjectionSnapshotQuery;
      const source = Option.getOrNull(yield* projection.getThreadShellById(invocation.threadId));
      if (!source || source.runtimeMode !== "full-access" || source.interactionMode === "plan") {
        return { error: "Customizing the app requires an active thread in Full access mode." };
      }
      const config = yield* ServerConfig.ServerConfig;
      try {
        return writeCustomization(config.stateDir, input.customization, input.expectedRevision);
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Could not apply customization." };
      }
    }),
} satisfies Parameters<typeof CustomizationToolkit.toLayer>[0];

export const CustomizationToolkitHandlersLive = CustomizationToolkit.toLayer(handlers);
