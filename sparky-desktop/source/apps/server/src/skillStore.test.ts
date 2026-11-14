// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as SkillStore from "./skillStore.ts";

it("saves, lists, and removes only Sparky-managed skills", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(process.cwd(), ".skill-store-test-"));
  vi.stubEnv("SPARKY_SKILLS_DIR", directory);
  try {
    const store = await Effect.runPromise(SkillStore.SkillStoreService.pipe(Effect.provide(SkillStore.layer)));
    await NodeFSP.mkdir(NodePath.join(directory, "existing"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(directory, "existing", "SKILL.md"), "---\nname: existing\n---\nNot managed", "utf8");

    await expect(Effect.runPromise(store.save({ name: "custom-flow", description: "Custom flow", content: "Do the task." }))).resolves.toMatchObject({ name: "custom-flow" });
    await expect(Effect.runPromise(store.list())).resolves.toMatchObject({ skills: [{ name: "custom-flow", description: "Custom flow", content: "Do the task." }] });
    await expect(Effect.runPromise(store.save({ name: "existing", description: "", content: "Overwrite" }))).rejects.toMatchObject({ _tag: "SkillError", operation: "save" });
    await expect(Effect.runPromise(store.remove({ name: "custom-flow" }))).resolves.toEqual({ deleted: true });
    expect(await NodeFSP.readFile(NodePath.join(directory, "existing", "SKILL.md"), "utf8")).toContain("Not managed");
  } finally {
    vi.unstubAllEnvs();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
