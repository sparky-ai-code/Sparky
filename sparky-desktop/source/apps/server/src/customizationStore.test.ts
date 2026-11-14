// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_CUSTOMIZATION } from "@sparky/shared/customization";
import {
  CustomizationConflictError, customizationFilePath, readCustomization, writeCustomization,
} from "./customizationStore";

const roots: string[] = [];
function tmp(): string {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sparky-customization-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("customization persistence", () => {
  it("returns defaults and atomically saves a new theme", () => {
    const dir = tmp();
    const before = readCustomization(dir);
    expect(before.customization).toEqual(DEFAULT_CUSTOMIZATION);
    const next = writeCustomization(dir, { ...DEFAULT_CUSTOMIZATION, name: "My Theme" }, before.revision);
    expect(next.customization.name).toBe("My Theme");
    expect(readCustomization(dir).revision).toBe(next.revision);
    expect(NodeFS.readdirSync(dir)).toEqual(["customization.json"]);
    expect(JSON.parse(NodeFS.readFileSync(customizationFilePath(dir), "utf8")).name).toBe("My Theme");
  });

  it("prevents stale saves overwriting an agent edit", () => {
    const dir = tmp();
    const revision = readCustomization(dir).revision;
    writeCustomization(dir, { ...DEFAULT_CUSTOMIZATION, name: "Agent" }, revision);
    expect(() => writeCustomization(dir, DEFAULT_CUSTOMIZATION, revision))
      .toThrow(CustomizationConflictError);
    expect(readCustomization(dir).customization.name).toBe("Agent");
  });

  it("rejects symlinks and invalid files, but permits explicit recovery", () => {
    const dir = tmp();
    const target = NodePath.join(dir, "not-a-theme.json");
    NodeFS.writeFileSync(target, "SECRET");
    NodeFS.symlinkSync(target, customizationFilePath(dir));
    expect(readCustomization(dir).error).toBeDefined();
    expect(() => writeCustomization(dir, DEFAULT_CUSTOMIZATION, "stale"))
      .toThrow(CustomizationConflictError);
    const result = writeCustomization(dir, DEFAULT_CUSTOMIZATION, "*");
    expect(result.customization).toEqual(DEFAULT_CUSTOMIZATION);
    expect(NodeFS.readFileSync(target, "utf8")).toBe("SECRET");
    expect(readCustomization(dir).error).toBeUndefined();
  });

  it("never publishes malformed JSON as a theme", () => {
    const dir = tmp();
    NodeFS.writeFileSync(customizationFilePath(dir), "{broken");
    expect(readCustomization(dir).error).toBeDefined();
    expect(readCustomization(dir).customization).toEqual(DEFAULT_CUSTOMIZATION);
  });
});
