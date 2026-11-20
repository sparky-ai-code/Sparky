import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { Team, TeamsError } from "@sparky/contracts";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

const TEAMS_STORE_VERSION = 1;

const TeamsFile = Schema.Struct({
  version: Schema.Literal(TEAMS_STORE_VERSION),
  teams: Schema.Array(Team),
});
const decodeTeamsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamsFile));

const storeError = (operation: string, detail: string, cause?: unknown) =>
  new TeamsError({ operation, detail, ...(cause !== undefined ? { cause } : {}) });

/**
 * TeamsStore - Persists all teams as one JSON file under the server state directory.
 *
 * A missing file reads as an empty list. A file that exists but cannot be read
 * or decoded is an error, so a later write can never silently discard teams.
 */
export class TeamsStore extends Context.Service<
  TeamsStore,
  {
    readonly read: Effect.Effect<ReadonlyArray<Team>, TeamsError>;
    readonly write: (teams: ReadonlyArray<Team>) => Effect.Effect<void, TeamsError>;
  }
>()("t3/teams/TeamsStore") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const teamsFilePath = path.join(config.stateDir, "teams", "teams.json");

  const read: TeamsStore["Service"]["read"] = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(teamsFilePath)
      .pipe(
        Effect.mapError((cause) =>
          storeError("TeamsStore.read", "Could not check the teams file.", cause),
        ),
      );
    if (!exists) {
      return [];
    }

    const contents = yield* fileSystem
      .readFileString(teamsFilePath)
      .pipe(
        Effect.mapError((cause) =>
          storeError("TeamsStore.read", "Could not read the teams file.", cause),
        ),
      );
    const decoded = yield* decodeTeamsFile(contents).pipe(
      Effect.mapError((cause) =>
        storeError("TeamsStore.read", "The teams file is not valid.", cause),
      ),
    );
    return decoded.teams;
  });

  const write: TeamsStore["Service"]["write"] = (teams) =>
    writeFileStringAtomically({
      filePath: teamsFilePath,
      contents: `${JSON.stringify({ version: TEAMS_STORE_VERSION, teams }, null, 2)}\n`,
    }).pipe(
      Effect.mapError((cause) =>
        storeError("TeamsStore.write", "Could not save the teams file.", cause),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  return TeamsStore.of({ read, write });
});

export const layer = Layer.effect(TeamsStore, make);
