import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as OptionModule from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const AccountSessionDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedToken: Schema.String,
});
type AccountSessionDocument = typeof AccountSessionDocument.Type;

const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(AccountSessionDocument));
const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(AccountSessionDocument));

export class DesktopAccountSessionStore extends Context.Service<
  DesktopAccountSessionStore,
  {
    readonly get: Effect.Effect<OptionModule.Option<string>>;
    readonly set: (token: string | null) => Effect.Effect<boolean>;
  }
>()("@sparky/desktop/app/DesktopAccountSessionStore") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const accountSessionPath = path.join(environment.stateDir, "account-session.json");

  const readDocument = fileSystem.readFileString(accountSessionPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed<string | null>(null) : Effect.fail(error),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(OptionModule.none<AccountSessionDocument>())
        : decodeDocument(raw).pipe(
            Effect.map(OptionModule.some),
            Effect.orElseSucceed(() => OptionModule.none()),
          ),
    ),
  );

  const get: DesktopAccountSessionStore["Service"]["get"] = Effect.gen(function* () {
    if (!(yield* safeStorage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false)))) {
      return OptionModule.none<string>();
    }
    const document = yield* readDocument.pipe(Effect.orElseSucceed(() => OptionModule.none()));
    if (OptionModule.isNone(document)) return OptionModule.none<string>();
    const encrypted = yield* Encoding.decodeBase64(document.value.encryptedToken).pipe(
      Effect.orElseSucceed(() => new Uint8Array()),
    );
    if (encrypted.byteLength === 0) return OptionModule.none<string>();
    return yield* safeStorage.decryptString(encrypted).pipe(
      Effect.map(OptionModule.some),
      Effect.orElseSucceed(() => OptionModule.none()),
    );
  });

  const set: DesktopAccountSessionStore["Service"]["set"] = Effect.fn(
    "desktop.accountSessionStore.set",
  )(function* (token) {
    if (token === null) {
      yield* fileSystem.remove(accountSessionPath, { force: true }).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return true;
    }
    if (!(yield* safeStorage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false)))) {
      return false;
    }
    const encryptedToken = Encoding.encodeBase64(
      yield* safeStorage.encryptString(token).pipe(Effect.orElseSucceed(() => new Uint8Array())),
    );
    if (!encryptedToken) return false;
    const encoded = yield* encodeDocument({ version: 1, encryptedToken }).pipe(
      Effect.orElseSucceed(() => ""),
    );
    if (!encoded) return false;
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true }).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const temporaryPath = `${accountSessionPath}.${process.pid}.tmp`;
    yield* fileSystem.writeFileString(temporaryPath, `${encoded}\n`).pipe(
      Effect.flatMap(() => fileSystem.chmod(temporaryPath, 0o600)),
      Effect.flatMap(() => fileSystem.rename(temporaryPath, accountSessionPath)),
      Effect.ensuring(
        fileSystem
          .remove(temporaryPath, { force: true })
          .pipe(Effect.orElseSucceed(() => undefined)),
      ),
    );
    yield* fileSystem.chmod(accountSessionPath, 0o600).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    return true;
  });

  return DesktopAccountSessionStore.of({ get, set });
});

export const layer = Layer.effect(DesktopAccountSessionStore, make);
