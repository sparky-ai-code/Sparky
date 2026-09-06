import { describe, expect, it } from "@effect/vitest";

import { ProjectId } from "@sparky/contracts";
import { resolveProjectTarget } from "./handlers.ts";

const project = (id: string, title: string) => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `C:/work/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("cross-project MCP project targeting", () => {
  it("resolves an exact project id and rejects mismatched titles", () => {
    const projects = [project("one", "One"), project("two", "Two")];
    expect(resolveProjectTarget(projects, { projectId: "one" })).toEqual({ project: projects[0] });
    expect(resolveProjectTarget(projects, { projectId: "one", projectTitle: "Two" })).toMatchObject(
      {
        error: { status: "error", data: { code: "project_target_mismatch" } },
      },
    );
  });

  it("does not guess when a title is ambiguous", () => {
    const projects = [project("one", "Workspace"), project("two", "Workspace")];
    expect(resolveProjectTarget(projects, { projectTitle: "workspace" })).toMatchObject({
      error: { status: "error", data: { code: "ambiguous_project" } },
    });
  });
});
