// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import {
  Memory,
  MemoryAddInput,
  MemoryDeleteInput,
  MemoryError,
  MemoryListInput,
  MemoryListResult,
  MemoryUpdateInput,
} from "@sparky/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@sparky/shared/hostProcess";
import * as ServerConfig from "./config.ts";

const MEMORY_FILE_NAME = "memories.json";
const MAX_MEMORY_CONTENT_CHARS = 12_000;
const SENSITIVE_VALUE =
  /(?:api[_ -]?key|token|password|secret|private[_ -]?key)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|xoxb|AKIA)[A-Za-z0-9_-]{12,}\b/i;

type StoredMemory = {
  id: string;
  scope: "global" | "project";
  title: string;
  content: string;
  category: string;
  importance: number;
  created_at: string;
  updated_at: string;
  source?: string;
};

interface LoadedStore {
  readonly globalFile: string;
  readonly legacyGlobalFile: string;
  readonly projectFile: string;
  memories: StoredMemory[];
}
export class MemoryStoreService extends Context.Service<
  MemoryStoreService,
  {
    readonly list: (input: MemoryListInput) => Effect.Effect<MemoryListResult, MemoryError>;
    readonly add: (input: MemoryAddInput) => Effect.Effect<Memory, MemoryError>;
    readonly update: (input: MemoryUpdateInput) => Effect.Effect<Memory, MemoryError>;
    readonly remove: (
      input: MemoryDeleteInput,
    ) => Effect.Effect<{ readonly deleted: boolean }, MemoryError>;
  }
>()("t3/memoryStore/MemoryStoreService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  // Do not make an unreadable memory file take down the whole websocket layer.
  // Each command reports a typed, actionable MemoryError to Settings instead.
  const store = createStore(config.cwd, environment, platform);
  const writeSemaphore = yield* Semaphore.make(1);

  const reload = (operation: string) =>
    Effect.tryPromise({
      try: () => reloadStore(store),
      catch: (cause) => memoryError(operation, cause),
    });
  const list = (input: MemoryListInput) =>
    reload("list").pipe(Effect.map(() => ({ memories: search(store, input.query ?? "") })));

  const add = (input: MemoryAddInput) =>
    writeSemaphore.withPermit(
      Effect.tryPromise({
        try: async () => {
          await reloadStore(store);
          const now = new Date().toISOString();
          const memory: StoredMemory = {
            id: NodeCrypto.randomUUID(),
            scope: input.scope,
            title: input.title,
            content: input.content,
            category: input.category ?? "general",
            importance: input.importance ?? 3,
            created_at: now,
            updated_at: now,
            source: input.source ?? "settings",
          };
          validate(memory.title, memory.content);
          store.memories.push(memory);
          await persistStore(store, memory.scope);
          return toContract(memory);
        },
        catch: (cause) => memoryError("add", cause),
      }),
    );

  const update = (input: MemoryUpdateInput) =>
    writeSemaphore.withPermit(
      Effect.tryPromise({
        try: async () => {
          await reloadStore(store);
          const index = store.memories.findIndex((memory) => memory.id === input.id);
          if (index < 0) throw new Error(`Memory '${input.id}' was not found.`);
          const existing = store.memories[index]!;
          const next: StoredMemory = {
            ...existing,
            title: input.title,
            content: input.content,
            category: input.category ?? existing.category,
            importance: input.importance ?? existing.importance,
            updated_at: new Date().toISOString(),
            ...(input.source !== undefined ? { source: input.source } : {}),
          };
          validate(next.title, next.content);
          store.memories[index] = next;
          await persistStore(store, next.scope);
          return toContract(next);
        },
        catch: (cause) => memoryError("update", cause),
      }),
    );

  const remove = (input: MemoryDeleteInput) =>
    writeSemaphore.withPermit(
      Effect.tryPromise({
        try: async () => {
          await reloadStore(store);
          const index = store.memories.findIndex((memory) => memory.id === input.id);
          if (index < 0) return { deleted: false };
          const [deleted] = store.memories.splice(index, 1);
          await persistStore(store, deleted!.scope);
          return { deleted: true };
        },
        catch: (cause) => memoryError("delete", cause),
      }),
    );

  return { list, add, update, remove };
});

export const layer = Layer.effect(MemoryStoreService, make);

export function resolveGlobalMemoryFile(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory = environment.USERPROFILE ?? environment.HOME ?? ".",
): string {
  const configuredDirectory = environment.SPARKY_MEMORY_GLOBAL_DIR?.trim();
  if (configuredDirectory) return NodePath.join(configuredDirectory, MEMORY_FILE_NAME);

  const sparkyHome = environment.SPARKY_HOME?.trim();
  if (sparkyHome) return NodePath.join(sparkyHome, "memory", MEMORY_FILE_NAME);

  const legacyHome = environment.T3CODE_HOME?.trim();
  if (legacyHome) return NodePath.join(legacyHome, "memory", MEMORY_FILE_NAME);

  if (platform === "win32") {
    const appData = environment.LOCALAPPDATA?.trim() || environment.APPDATA?.trim();
    if (appData) return NodePath.join(appData, "Sparky", "memory", MEMORY_FILE_NAME);
    if (environment.USERPROFILE?.trim()) {
      return NodePath.join(environment.USERPROFILE, ".sparky", "global", MEMORY_FILE_NAME);
    }
  } else {
    const xdgDataHome = environment.XDG_DATA_HOME?.trim();
    if (xdgDataHome) return NodePath.join(xdgDataHome, "Sparky", "memory", MEMORY_FILE_NAME);
    if (environment.HOME?.trim()) {
      return NodePath.join(
        environment.HOME,
        ".local",
        "share",
        "Sparky",
        "memory",
        MEMORY_FILE_NAME,
      );
    }
  }

  return NodePath.join(homeDirectory, ".sparky", "global", MEMORY_FILE_NAME);
}

function createStore(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): LoadedStore {
  const globalFile = resolveGlobalMemoryFile(environment, platform);
  const legacyGlobalFile = NodePath.join(cwd, ".sparky", "global", MEMORY_FILE_NAME);
  const projectFile = NodePath.join(cwd, ".sparky", MEMORY_FILE_NAME);
  return {
    globalFile,
    legacyGlobalFile,
    projectFile,
    memories: [],
  } satisfies LoadedStore;
}

async function reloadStore(store: LoadedStore): Promise<LoadedStore> {
  const [global, project] = await Promise.all([
    readFile(store.globalFile),
    readFile(store.projectFile),
  ]);
  // The old project-local global store is a migration fallback only. Once the
  // canonical store exists it must stay authoritative, otherwise deleting an
  // old memory would make it reappear on the next reload.
  const legacyGlobal =
    global.exists || store.legacyGlobalFile === store.globalFile
      ? []
      : (await readFile(store.legacyGlobalFile)).memories;
  const byId = new Map<string, StoredMemory>();
  for (const memory of [...legacyGlobal, ...global.memories, ...project.memories]) {
    byId.set(memory.id, memory);
  }
  store.memories = [...byId.values()];
  return store;
}

async function readFile(
  path: string,
): Promise<{ readonly exists: boolean; readonly memories: ReadonlyArray<StoredMemory> }> {
  const backup = `${path}.bak`;
  try {
    const raw = await NodeFSP.readFile(path, "utf8");
    try {
      return { exists: true, memories: decodeMemoryFile(raw, path) };
    } catch (primaryError) {
      try {
        const backupRaw = await NodeFSP.readFile(backup, "utf8");
        return { exists: true, memories: decodeMemoryFile(backupRaw, backup) };
      } catch (backupError) {
        if (isNotFound(backupError)) throw primaryError;
        throw new Error(
          `Could not recover invalid memory store '${path}' from '${backup}': ${errorMessage(backupError)}`,
          { cause: backupError },
        );
      }
    }
  } catch (error) {
    if (!isNotFound(error)) {
      if (error instanceof Error && error.message.includes(`'${path}'`)) throw error;
      throw new Error(`Could not read memory store '${path}': ${errorMessage(error)}`, {
        cause: error,
      });
    }
    try {
      const backupRaw = await NodeFSP.readFile(backup, "utf8");
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.rename(backup, path);
      return { exists: true, memories: decodeMemoryFile(backupRaw, backup) };
    } catch (backupError) {
      if (isNotFound(backupError)) return { exists: false, memories: [] };
      throw new Error(
        `Could not read memory store backup '${backup}': ${errorMessage(backupError)}`,
        {
          cause: backupError,
        },
      );
    }
  }
}

async function persistStore(store: LoadedStore, scope: StoredMemory["scope"]): Promise<void> {
  const path = scope === "global" ? store.globalFile : store.projectFile;
  const memories = store.memories.filter((memory) => memory.scope === scope);
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const backup = `${path}.bak`;
  await NodeFSP.writeFile(
    temporary,
    `${JSON.stringify({ version: 1, memories }, null, 2)}\n`,
    "utf8",
  );
  await NodeFSP.rm(backup, { force: true });
  let hadPrevious = false;
  try {
    await NodeFSP.rename(path, backup);
    hadPrevious = true;
  } catch (error) {
    if (!isNotFound(error)) {
      await NodeFSP.rm(temporary, { force: true });
      throw error;
    }
  }
  try {
    await NodeFSP.rename(temporary, path);
    await NodeFSP.rm(backup, { force: true });
  } catch (error) {
    await NodeFSP.rm(temporary, { force: true });
    if (hadPrevious) {
      await NodeFSP.rename(backup, path).catch(() => undefined);
    }
    throw error;
  }
}

function decodeMemoryFile(raw: string, path: string): ReadonlyArray<StoredMemory> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Memory store '${path}' contains invalid JSON: ${errorMessage(cause)}`, {
      cause,
    });
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.memories)) {
    throw new Error(`Memory store '${path}' is invalid: expected version 1 with a memories array.`);
  }
  for (const [index, memory] of parsed.memories.entries()) {
    if (!isStoredMemory(memory)) {
      throw new Error(`Memory store '${path}' has an invalid memory at index ${index}.`);
    }
  }
  return parsed.memories;
}

function isStoredMemory(value: unknown): value is StoredMemory {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.scope === "global" || value.scope === "project") &&
    typeof value.title === "string" &&
    typeof value.content === "string" &&
    typeof value.category === "string" &&
    Number.isInteger(value.importance) &&
    Number(value.importance) >= 1 &&
    Number(value.importance) <= 5 &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    (value.source === undefined || typeof value.source === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function search(store: LoadedStore, query: string): ReadonlyArray<Memory> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return store.memories
    .map((memory) => ({
      memory,
      score: terms.filter((term) =>
        `${memory.title} ${memory.content} ${memory.category}`.toLocaleLowerCase().includes(term),
      ).length,
    }))
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || b.memory.importance - a.memory.importance)
    .map(({ memory }) => toContract(memory));
}

function validate(title: string, content: string): void {
  if (!title.trim()) throw new Error("Memory title cannot be empty.");
  if (!content.trim()) throw new Error("Memory content cannot be empty.");
  if (content.length > MAX_MEMORY_CONTENT_CHARS) {
    throw new Error(`Memory content is too long (maximum ${MAX_MEMORY_CONTENT_CHARS} characters).`);
  }
  if (SENSITIVE_VALUE.test(`${title}\n${content}`)) {
    throw new Error("Memory was not saved because it appears to contain a secret or credential.");
  }
}

function toContract(memory: StoredMemory): Memory {
  return {
    id: memory.id,
    scope: memory.scope,
    title: memory.title,
    content: memory.content,
    category: memory.category,
    importance: memory.importance,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
    ...(memory.source ? { source: memory.source } : {}),
  };
}

function memoryError(operation: string, cause: unknown): MemoryError {
  return new MemoryError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
