// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopAccountSessionStore from "./DesktopAccountSessionStore.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function makeLayer(baseDir: string, encryptionAvailable = true) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(encryptionAvailable),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) =>
      Effect.gen(function* () {
        const decoded = textDecoder.decode(value);
        if (!decoded.startsWith("encrypted:")) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted token"),
          });
        }
        return decoded.slice("encrypted:".length);
      }),
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

  return DesktopAccountSessionStore.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(safeStorageLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopAccountSessionStore.DesktopAccountSessionStore>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "sparky-account-session-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopAccountSessionStore", () => {
  it.effect("persists and clears an encrypted account session", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopAccountSessionStore.DesktopAccountSessionStore;
        const token = "opaque-session-token";

        assert.isTrue(yield* store.set(token));
        assert.deepStrictEqual(yield* store.get, Option.some(token));
        assert.isTrue(yield* store.set(null));
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
    ),
  );

  it.effect("reports unavailable secure storage without persisting the token", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopAccountSessionStore.DesktopAccountSessionStore;
        assert.isFalse(yield* store.set("opaque-session-token"));
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
      false,
    ),
  );
});
