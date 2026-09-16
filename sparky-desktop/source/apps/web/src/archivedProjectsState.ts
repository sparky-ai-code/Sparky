import { useSyncExternalStore } from "react";

const ARCHIVED_PROJECTS_STORAGE_KEY = "sparky:archived-projects:v1";

export interface ArchivedProjectEntry {
  readonly key: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly environmentLabel: string | null;
  readonly archivedAt: string;
}

export interface ArchiveProjectInput {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly environmentLabel?: string | null;
}

interface ProjectRemovalDescriptor {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly environmentLabel: string | null;
}

let cachedEntries: ReadonlyArray<ArchivedProjectEntry> | null = null;
const listeners = new Set<() => void>();

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function projectArchiveKey(input: {
  readonly workspaceRoot: string;
  readonly environmentLabel?: string | null;
}): string {
  return `${input.environmentLabel?.trim().toLocaleLowerCase() ?? ""}:${normalizeWorkspaceRoot(
    input.workspaceRoot,
  )}`;
}

function readPersistedEntries(): ReadonlyArray<ArchivedProjectEntry> {
  if (cachedEntries !== null) return cachedEntries;
  if (typeof window === "undefined") {
    cachedEntries = [];
    return cachedEntries;
  }

  try {
    const raw = window.localStorage.getItem(ARCHIVED_PROJECTS_STORAGE_KEY);
    if (!raw) {
      cachedEntries = [];
      return cachedEntries;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      cachedEntries = [];
      return cachedEntries;
    }
    cachedEntries = parsed.flatMap((entry): ArchivedProjectEntry[] => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { key?: unknown }).key !== "string" ||
        typeof (entry as { title?: unknown }).title !== "string" ||
        typeof (entry as { workspaceRoot?: unknown }).workspaceRoot !== "string" ||
        typeof (entry as { archivedAt?: unknown }).archivedAt !== "string"
      ) {
        return [];
      }
      const environmentLabel = (entry as { environmentLabel?: unknown }).environmentLabel;
      return [
        {
          key: (entry as { key: string }).key,
          title: (entry as { title: string }).title,
          workspaceRoot: (entry as { workspaceRoot: string }).workspaceRoot,
          environmentLabel: typeof environmentLabel === "string" ? environmentLabel : null,
          archivedAt: (entry as { archivedAt: string }).archivedAt,
        },
      ];
    });
  } catch {
    cachedEntries = [];
  }
  return cachedEntries;
}

function persistEntries(entries: ReadonlyArray<ArchivedProjectEntry>): void {
  cachedEntries = entries;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ARCHIVED_PROJECTS_STORAGE_KEY, JSON.stringify(entries));
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function archiveProject(input: ArchiveProjectInput): ArchivedProjectEntry {
  const environmentLabel = input.environmentLabel?.trim() || null;
  const key = projectArchiveKey({
    workspaceRoot: input.workspaceRoot,
    environmentLabel,
  });
  const entry: ArchivedProjectEntry = {
    key,
    title: input.title.trim(),
    workspaceRoot: input.workspaceRoot.trim(),
    environmentLabel,
    archivedAt: new Date().toISOString(),
  };
  const current = readPersistedEntries();
  persistEntries([entry, ...current.filter((candidate) => candidate.key !== key)]);
  return entry;
}

export function parseProjectRemovalMessage(message: string): ProjectRemovalDescriptor | null {
  const titleMatch = message.match(/^Remove project \"([^\"]+)\"/m);
  const pathMatch = message.match(/^Path:\s*(.+)$/m);
  if (!titleMatch?.[1] || !pathMatch?.[1]) return null;
  const environmentMatch = message.match(/^Environment:\s*(.+)$/m);
  return {
    title: titleMatch[1].trim(),
    workspaceRoot: pathMatch[1].trim(),
    environmentLabel: environmentMatch?.[1]?.trim() ?? null,
  };
}

export function isProjectRemovalMessage(message: string): boolean {
  return parseProjectRemovalMessage(message) !== null;
}

export function archiveProjectFromRemovalMessage(message: string): ArchivedProjectEntry | null {
  const descriptor = parseProjectRemovalMessage(message);
  return descriptor ? archiveProject(descriptor) : null;
}

export function restoreArchivedProject(key: string): void {
  persistEntries(readPersistedEntries().filter((entry) => entry.key !== key));
}

export function removeArchivedProjectRecordForPath(workspaceRoot: string): void {
  const normalized = normalizeWorkspaceRoot(workspaceRoot);
  persistEntries(
    readPersistedEntries().filter(
      (entry) => normalizeWorkspaceRoot(entry.workspaceRoot) !== normalized,
    ),
  );
}

export function isWorkspaceRootArchived(workspaceRoot: string): boolean {
  const normalized = normalizeWorkspaceRoot(workspaceRoot);
  return readPersistedEntries().some(
    (entry) => normalizeWorkspaceRoot(entry.workspaceRoot) === normalized,
  );
}

export function useArchivedProjects(): ReadonlyArray<ArchivedProjectEntry> {
  return useSyncExternalStore(subscribe, readPersistedEntries, () => []);
}

export function __resetArchivedProjectsForTests(): void {
  cachedEntries = [];
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(ARCHIVED_PROJECTS_STORAGE_KEY);
  }
  for (const listener of listeners) listener();
}
