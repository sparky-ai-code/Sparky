import { WS_METHODS } from "@sparky/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createMicroboxesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycle = createAtomCommandScheduler();
  const controls = createAtomCommandScheduler();
  const scoped = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { boxId: string } }) =>
      JSON.stringify([environmentId, input.boxId]),
  };
  return {
    importImage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:import-image",
      tag: WS_METHODS.microboxImportImage,
      scheduler: lifecycle,
    }),
    images: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:microboxes:images",
      tag: WS_METHODS.microboxImages,
      staleTimeMs: 3_000,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:microboxes:list",
      tag: WS_METHODS.microboxList,
      staleTimeMs: 1_000,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:create",
      tag: WS_METHODS.microboxCreate,
      scheduler: lifecycle,
    }),
    status: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:status",
      tag: WS_METHODS.microboxStatus,
      scheduler: controls,
    }),
    snapshot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:snapshot",
      tag: WS_METHODS.microboxSnapshot,
      scheduler: controls,
      concurrency: { mode: "singleFlight" as const, key: scoped.key },
    }),
    click: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:click",
      tag: WS_METHODS.microboxClick,
      scheduler: controls, concurrency: scoped,
    }),
    drag: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:drag",
      tag: WS_METHODS.microboxDrag,
      scheduler: controls, concurrency: scoped,
    }),
    scroll: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:scroll",
      tag: WS_METHODS.microboxScroll,
      scheduler: controls, concurrency: scoped,
    }),
    type: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:type",
      tag: WS_METHODS.microboxType,
      scheduler: controls, concurrency: scoped,
    }),
    press: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:press",
      tag: WS_METHODS.microboxPress,
      scheduler: controls, concurrency: scoped,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:stop",
      tag: WS_METHODS.microboxStop,
      scheduler: lifecycle, concurrency: scoped,
    }),
    destroy: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:microboxes:destroy",
      tag: WS_METHODS.microboxDestroy,
      scheduler: lifecycle, concurrency: scoped,
    }),
  };
}
