import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetArchivedProjectsForTests,
  archiveProject,
  archiveProjectFromRemovalMessage,
  isProjectRemovalMessage,
  isWorkspaceRootArchived,
  parseProjectRemovalMessage,
  restoreArchivedProject,
} from "./archivedProjectsState";

function installLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
}

describe("archivedProjectsState", () => {
  beforeEach(() => {
    installLocalStorage();
    __resetArchivedProjectsForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the existing sidebar project-removal confirmation format", () => {
    const message = [
      'Remove project "agent" and delete its 3 threads?',
      "Path: C:\\Users\\Lenovo\\downloads\\AI and Machine Learning\\agent",
      "Environment: DESKTOP-V4HRJ58",
      "This removes only this project entry.",
    ].join("\n");

    expect(isProjectRemovalMessage(message)).toBe(true);
    expect(parseProjectRemovalMessage(message)).toEqual({
      title: "agent",
      workspaceRoot: "C:\\Users\\Lenovo\\downloads\\AI and Machine Learning\\agent",
      environmentLabel: "DESKTOP-V4HRJ58",
    });
  });

  it("archives directly by workspace root and restores without touching the folder", () => {
    const archived = archiveProject({
      title: "agent",
      workspaceRoot: "C:\\Users\\Lenovo\\downloads\\agent",
      environmentLabel: "DESKTOP-V4HRJ58",
    });

    expect(isWorkspaceRootArchived("C:/Users/Lenovo/downloads/agent/")).toBe(true);

    restoreArchivedProject(archived.key);
    expect(isWorkspaceRootArchived("C:\\Users\\Lenovo\\downloads\\agent")).toBe(false);
  });

  it("keeps the legacy removal-message archive adapter working", () => {
    const message = [
      'Remove project "agent"?',
      "Path: C:\\Users\\Lenovo\\downloads\\agent",
      "This removes only this project entry.",
    ].join("\n");

    const archived = archiveProjectFromRemovalMessage(message);
    expect(archived).not.toBeNull();
    expect(isWorkspaceRootArchived("C:/Users/Lenovo/downloads/agent/")).toBe(true);
  });
});
