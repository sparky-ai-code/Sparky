import type { ServerProvider } from "@sparky/contracts";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /** Acquire before forking a consumer so the first refresh cannot be lost. */
  readonly subscribeChanges?: Effect.Effect<
    PubSub.Subscription<ServerProvider>,
    never,
    Scope.Scope
  >;
}
