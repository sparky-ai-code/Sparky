import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { SpawnThreadToolkit } from "./tools.ts";

it("exposes configurable thread, model, project, and workspace fields", () => {
  const tool = SpawnThreadToolkit.tools.sparky_spawn_thread;
  const schema = Tool.getJsonSchema(tool) as {
    readonly type?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };

  expect(tool.description?.length ?? 0).toBeGreaterThan(40);
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(expect.arrayContaining(["prompt", "instanceId", "model"]));
  expect(schema.required).not.toContain("projectId");
  expect(schema.required).not.toContain("workspaceMode");
  expect(schema.properties).toMatchObject({
    projectId: expect.any(Object),
    prompt: expect.any(Object),
    modelOptions: expect.any(Object),
    workspaceMode: expect.any(Object),
    baseBranch: expect.any(Object),
    runtimeMode: expect.any(Object),
    interactionMode: expect.any(Object),
  });
});
