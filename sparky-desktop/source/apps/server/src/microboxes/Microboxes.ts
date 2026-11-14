// @effect-diagnostics nodeBuiltinImport:off - Host lifecycle belongs to the server process.
import * as Path from "node:path";
import * as Fs from "node:fs/promises";
import type {
  MicroboxCreateInput, MicroboxImage, MicroboxStatus, MicroboxSnapshot, MicroboxTarget,
} from "@sparky/contracts";
import { MicroboxError } from "@sparky/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { HostBoxManager, MicroboxHostError } from "./HostBoxManager.ts";

type Target = MicroboxTarget;
type BoxAction<A> = Effect.Effect<A, MicroboxError>;
export interface MicroboxesService {
  readonly images: BoxAction<MicroboxImage[]>;
  readonly importImage: (path: string) => BoxAction<MicroboxImage>;
  readonly list: (threadId: string) => BoxAction<MicroboxStatus[]>;
  readonly create: (input: MicroboxCreateInput, workspaceRoot?: string) => BoxAction<MicroboxStatus>;
  readonly status: (target: Target) => BoxAction<MicroboxStatus>;
  readonly snapshot: (target: Target) => BoxAction<MicroboxSnapshot>;
  readonly click: (target: Target & { x: number; y: number; button?: "left" | "right" | "middle" }) => BoxAction<void>;
  readonly type: (target: Target & { text: string }) => BoxAction<void>;
  readonly scroll: (target: Target & { direction: "up" | "down"; steps: number }) => BoxAction<void>;
  readonly drag: (target: Target & {
    fromX: number; fromY: number; toX: number; toY: number; durationMs?: number;
  }) => BoxAction<void>;
  readonly press: (target: Target & { key: string }) => BoxAction<void>;
  readonly stop: (target: Target) => BoxAction<void>;
  readonly destroy: (target: Target) => BoxAction<void>;
}
export class Microboxes extends Context.Service<Microboxes, MicroboxesService>()(
  "t3/microboxes/Microboxes",
) {}

const wrapError = (cause: unknown): MicroboxError => {
  if (Schema.is(MicroboxError)(cause)) return cause;
  if (cause instanceof MicroboxHostError) {
    return new MicroboxError({
      code: cause.code as MicroboxError["code"],
      message: cause.message,
    });
  }
  // Never leak host process paths or virtualizer output to the agent or UI.
  return new MicroboxError({ code: "io-error", message: "The box operation failed." });
};

export const layer = Layer.effect(
  Microboxes,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const orchestration = yield* OrchestrationEngineService;
    const manager = new HostBoxManager(Path.join(config.baseDir, "microboxes"));
    yield* Effect.addFinalizer(() => Effect.promise(() => manager.stopAll()));

    // The installer carries an architecture-matched, boot-tested guest image.
    // Import it once per backend lifetime, before image discovery or box creation.
    // The existing import validation enforces the image version and SHA256SUMS.
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const resourcesDir = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      ?? Path.resolve(Path.dirname(process.execPath),
        process.platform === "darwin" ? "../Resources" : "resources");
    const bundledImage = Path.join(resourcesDir, "microboxes", `sparky-micro-${arch}`);
    let imageSetup: Promise<void> | null = null;
    const ensureBundledImage = (): Promise<void> => {
      if (imageSetup) return imageSetup;
      imageSetup = (async () => {
        if (!(await Fs.stat(Path.join(bundledImage, "image.json")).then(
          (stat) => stat.isFile(), () => false
        ))) {
          // Local development and installations upgraded from earlier builds
          // may have a verified user-level guest without a packaged asset.
          if ((await manager.images()).length > 0) return;
          throw new MicroboxHostError("image-missing",
            "Sparky's built-in Linux guest is missing. Reinstall Sparky to restore Microboxes.");
        }
        await manager.importImage(bundledImage);
      })();
      return imageSetup;
    };

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

    // Delete per-thread private VM disks when the corresponding chat thread is deleted.
    yield* orchestration.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "thread.deleted"
          ? Effect.promise(() => manager.destroyThread(event.payload.threadId))
          : Effect.void,
      ),
      Effect.forkScoped,
    );

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
      images: guarded(async () => { await ensureBundledImage(); return manager.images(); }),
      importImage: (path) => guarded(() => manager.importImage(path)),
      list,
      create: (input, workspaceRoot) =>
        enabled.pipe(
          Effect.flatMap((current) =>
            input.internet && !current.microboxesInternetEnabled
              ? Effect.fail(
                  new MicroboxError({
                    code: "disabled",
                    message: "Enable internet access for Microboxes before creating an online box.",
                  }),
                )
              : Effect.tryPromise({
                  try: async () => {
                    await ensureBundledImage();
                    return manager.create(input, workspaceRoot);
                  },
                  catch: wrapError,
                }),
          ),
        ),
      status: ({ threadId, boxId }) =>
        guarded(() => Promise.resolve().then(() => manager.status(threadId, boxId))),
      snapshot: ({ threadId, boxId }) =>
        guarded(() => manager.snapshot(threadId, boxId)),
      click: ({ threadId, boxId, x, y, button }) =>
        guarded(() => manager.click(threadId, boxId, x, y, button ?? "left")),
      type: ({ threadId, boxId, text }) =>
        guarded(() => manager.type(threadId, boxId, text)),
      scroll: ({ threadId, boxId, direction, steps }) =>
        guarded(() => manager.scroll(threadId, boxId, direction, steps)),
      drag: ({ threadId, boxId, fromX, fromY, toX, toY, durationMs }) =>
        guarded(() => manager.drag(threadId, boxId, fromX, fromY, toX, toY, durationMs ?? 300)),
      press: ({ threadId, boxId, key }) =>
        guarded(() => manager.press(threadId, boxId, key)),
      stop: ({ threadId, boxId }) =>
        guarded(() => manager.stop(threadId, boxId)),
      destroy: ({ threadId, boxId }) =>
        guarded(() => manager.stop(threadId, boxId, true)),
    });
  }),
);
