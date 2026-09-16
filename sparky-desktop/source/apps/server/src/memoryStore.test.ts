// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ServerConfig from "./config.ts";
import * as MemoryStore from "./memoryStore.ts";

const TestLayer = NodeServices.layer;

it.layer(TestLayer, { excludeTestServices: true })("MemoryStore", (it) => {
  it.effect("reads global memories from the Rust runtime's shared location", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const globalDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-memory-global-",
      });
      const now = "2026-01-01T00:00:00.000Z";
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(globalDirectory, "memories.json"),
          `${JSON.stringify({
            version: 1,
            memories: [
              {
                id: "global-memory",
                scope: "global",
                title: "Shared preference",
                content: "Keep settings changes small.",
                category: "preference",
                importance: 4,
                created_at: now,
                updated_at: now,
                source: "agent",
              },
            ],
          })}\n`,
          "utf8",
        ),
      );
      vi.stubEnv("SPARKY_MEMORY_GLOBAL_DIR", globalDirectory);

      try {
        const memoryStoreLayer = MemoryStore.layer.pipe(
          Layer.provide(
            ServerConfig.ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-memory-store-test-",
            }),
          ),
          Layer.provide(NodeServices.layer),
        );
        const store = yield* MemoryStore.MemoryStoreService.pipe(Effect.provide(memoryStoreLayer));
        const result = yield* store.list({});
        expect(result.memories).toEqual([
          expect.objectContaining({
            id: "global-memory",
            scope: "global",
            title: "Shared preference",
          }),
        ]);
      } finally {
        vi.unstubAllEnvs();
      }
    }),
  );

  it.effect("reports an invalid store through the memory RPC error contract", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const globalDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "sparky-memory-invalid-",
      });
      const memoryFile = NodePath.join(globalDirectory, "memories.json");
      yield* Effect.promise(() => NodeFSP.writeFile(memoryFile, '{"version":1', "utf8"));
      vi.stubEnv("SPARKY_MEMORY_GLOBAL_DIR", globalDirectory);

      try {
        const memoryStoreLayer = MemoryStore.layer.pipe(
          Layer.provide(
            ServerConfig.ServerConfig.layerTest(process.cwd(), {
              prefix: "sparky-memory-invalid-store-test-",
            }),
          ),
          Layer.provide(NodeServices.layer),
        );
        const store = yield* MemoryStore.MemoryStoreService.pipe(Effect.provide(memoryStoreLayer));
        const error = yield* store.list({}).pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "MemoryError", operation: "list" });
        expect(error.message).toContain(memoryFile);
        expect(error.message).toContain("invalid JSON");
      } finally {
        vi.unstubAllEnvs();
      }
    }),
  );

  it.effect("uses the legacy global store only until the canonical store is created", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "sparky-memory-cwd-" });
      const globalDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "sparky-memory-canonical-",
      });
      const legacyDirectory = NodePath.join(cwd, ".sparky", "global");
      yield* Effect.promise(() => NodeFSP.mkdir(legacyDirectory, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(legacyDirectory, "memories.json"),
          `${JSON.stringify({
            version: 1,
            memories: [
              {
                id: "legacy-memory",
                scope: "global",
                title: "Legacy preference",
                content: "Preserve this during migration.",
                category: "preference",
                importance: 3,
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          })}\n`,
          "utf8",
        ),
      );
      vi.stubEnv("SPARKY_MEMORY_GLOBAL_DIR", globalDirectory);

      try {
        const memoryStoreLayer = MemoryStore.layer.pipe(
          Layer.provide(
            ServerConfig.ServerConfig.layerTest(cwd, {
              prefix: "sparky-memory-migration-store-test-",
            }),
          ),
          Layer.provide(NodeServices.layer),
        );
        const store = yield* MemoryStore.MemoryStoreService.pipe(Effect.provide(memoryStoreLayer));
        expect((yield* store.list({})).memories.map((memory) => memory.id)).toEqual([
          "legacy-memory",
        ]);

        const added = yield* store.add({
          scope: "global",
          title: "Canonical preference",
          content: "Use the canonical store.",
        });
        yield* store.remove({ id: "legacy-memory" });

        const reloaded = yield* store.list({});
        expect(reloaded.memories.map((memory) => memory.id)).toEqual([added.id]);
        const persisted = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(globalDirectory, "memories.json"), "utf8"),
        );
        expect(persisted).toContain(added.id);
      } finally {
        vi.unstubAllEnvs();
      }
    }),
  );
});

it("resolves the same global memory locations as the Rust runtime", () => {
  expect(
    MemoryStore.resolveGlobalMemoryFile(
      { SPARKY_HOME: "C:\\Users\\test\\.sparky" },
      "win32",
      "C:\\Users\\test",
    ),
  ).toBe(NodePath.join("C:\\Users\\test\\.sparky", "memory", "memories.json"));
  expect(
    MemoryStore.resolveGlobalMemoryFile(
      { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      "win32",
      "C:\\Users\\test",
    ),
  ).toBe(NodePath.join("C:\\Users\\test\\AppData\\Local", "Sparky", "memory", "memories.json"));
});
