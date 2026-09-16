// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileFinder } from "@ff-labs/fff-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-composer-browse-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-composer-browse-",
  });
});

function writeTextFile(cwd: string, relativePath: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, "test\n");
  });
}

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceEntries composer browse", (it) => {
  describe("bounded file preview", () => {
    it.effect("returns real root files and folders without creating the recursive search index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".hidden-secret");
        yield* writeTextFile(cwd, "a-file.ts");
        yield* writeTextFile(cwd, "b-folder/nested.ts");
        yield* writeTextFile(cwd, "c-file.md");

        const createSearchIndex = vi.spyOn(FileFinder, "create");
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.browse({
          cwd,
          partialPath: "./",
          includeFiles: true,
          limit: 2,
        });

        expect(result.entries).toEqual([
          expect.objectContaining({ name: "a-file.ts", kind: "file" }),
          expect.objectContaining({ name: "b-folder", kind: "directory" }),
        ]);
        expect(result.entries).toHaveLength(2);
        expect(result.entries.some((entry) => entry.name.startsWith("."))).toBe(false);
        expect(createSearchIndex).not.toHaveBeenCalled();
      }),
    );
  });
});
