// @effect-diagnostics nodeBuiltinImport:off - Host lifecycle belongs to the server process.
import * as Path from "node:path";
import type {
  MicroboxCreateInput, MicroboxImage, MicroboxStatus, MicroboxSnapshot, MicroboxTarget,
} from "@sparky/contracts";
import { MicroboxError } from "@sparky/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HostBoxManager, MicroboxHostError } from "./HostBoxManager.ts";

type Target = MicroboxTarget;
type BoxAction<A> = Effect.Effect<A, MicroboxError>;
export interface MicroboxesService {
  readonly images: BoxAction<MicroboxImage[]>;
  readonly list: (threadId: string) => BoxAction<MicroboxStatus[]>;
  readonly create: (input: MicroboxCreateInput) => BoxAction<MicroboxStatus>;
  readonly status: (target: Target) => BoxAction<MicroboxStatus>;
  readonly snapshot: (target: Target) => BoxAction<MicroboxSnapshot>;
  readonly click: (target: Target & { x: number; y: number; button?: "left" | "right" | "middle" }) => BoxAction<void>;
  readonly type: (target: Target & { text: string }) => BoxAction<void>;
  readonly press: (target: Target & { key: string }) => BoxAction<void>;
  readonly stop: (target: Target) => BoxAction<void>;
  readonly destroy: (target: Target) => BoxAction<void>;
}
export class Microboxes extends Context.Service<Microboxes, MicroboxesService>()(
  "sparky/server/Microboxes",
) {}

const wrapError = (cause: unknown): MicroboxError => {
  if (cause instanceof MicroboxError) return cause;
  if (cause instanceof MicroboxHostError) {
    return new MicroboxError({
      code: cause.code as MicroboxError["code"],
      message: cause.message,
    });
  }
  // Never leak host process paths or virtualizer output to the agent or UI.
  return new MicroboxError({ code: "io-error", message: "The box operation failed." });
};

export const layer = Layer.scoped(
  Microboxes,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const manager = new HostBoxManager(Path.join(config.baseDir, "microboxes"));
    yield* Effect.addFinalizer(() => Effect.promise(() => manager.stopAll()));

    const enabled = Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(Effect.mapError(wrapError));
      if (!current.microboxesEnabled) {
        return yield* new MicroboxError({
          code: "disabled",
          message: "Enable Sparky Microboxes in settings before using Boxes.",
        });
      }
      return current;
    });
    const guarded = <A>(operation: () => Promise<A>): BoxAction<A> =>
      enabled.pipe(
        Effect.flatMap(() => Effect.tryPromise({ try: operation, catch: wrapError })),
      );
    const list = (threadId: string): BoxAction<MicroboxStatus[]> =>
      enabled.pipe(Effect.map(() => manager.list(threadId)));

    // An opt-out is authoritative even for existing agents and running boxes.
    yield* settings.streamChanges.pipe(
      Stream.runForEach((next) =>
        next.microboxesEnabled
          ? Effect.sync(() => manager.resume())
          : Effect.promise(() => manager.stopAll()),
      ),
      Effect.forkScoped,
    );

    return Microboxes.of({
      images: guarded(() => manager.images()),
      list,
      create: (input) =>
        enabled.pipe(
          Effect.flatMap((current) =>
            input.internet && !current.microboxesInternetEnabled
              ? Effect.fail(
                  new MicroboxError({
                    code: "disabled",
                    message: "Enable internet access for Microboxes before creating an online box.",
                  }),
                )
              : Effect.tryPromise({ try: () => manager.create(input), catch: wrapError }),
          ),
        ),
      status: ({ threadId, boxId }) =>
        enabled.pipe(Effect.map(() => manager.status(threadId, boxId)), Effect.mapError(wrapError)),
      snapshot: ({ threadId, boxId }) =>
        guarded(() => manager.snapshot(threadId, boxId)),
      click: ({ threadId, boxId, x, y, button }) =>
        guarded(() => manager.click(threadId, boxId, x, y, button ?? "left")),
      type: ({ threadId, boxId, text }) =>
        guarded(() => manager.type(threadId, boxId, text)),
      press: ({ threadId, boxId, key }) =>
        guarded(() => manager.press(threadId, boxId, key)),
      stop: ({ threadId, boxId }) =>
        guarded(() => manager.stop(threadId, boxId)),
      destroy: ({ threadId, boxId }) =>
        guarded(() => manager.stop(threadId, boxId, true)),
    });
  }),
);
