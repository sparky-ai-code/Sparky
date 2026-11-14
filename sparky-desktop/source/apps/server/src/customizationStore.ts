// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  DEFAULT_CUSTOMIZATION,
  MAX_CUSTOMIZATION_BYTES,
  parseCustomization,
  type SparkyCustomization,
} from "@sparky/shared/customization";

export interface CustomizationSnapshot {
  customization: SparkyCustomization;
  revision: string;
  path: string;
  error?: string;
}

export class CustomizationConflictError extends Error {
  constructor() {
    super("Customization changed in another session. Refresh before saving, or reset explicitly.");
    this.name = "CustomizationConflictError";
  }
}

export function customizationFilePath(stateDir: string): string {
  return NodePath.join(stateDir, "customization.json");
}

function hash(value: SparkyCustomization): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readCustomization(stateDir: string): CustomizationSnapshot {
  const path = customizationFilePath(stateDir);
  const empty = { customization: DEFAULT_CUSTOMIZATION, revision: hash(DEFAULT_CUSTOMIZATION), path };
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return empty;
    }
    return { ...empty, error: "Could not read the customization file." };
  }
  // Do not follow symlinked config files, devices or unbounded files.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CUSTOMIZATION_BYTES) {
    return { ...empty, error: "The customization file is not a regular file within the size limit." };
  }
  try {
    const raw = NodeFS.readFileSync(path, "utf8");
    if (Buffer.byteLength(raw) > MAX_CUSTOMIZATION_BYTES) {
      return { ...empty, error: "The customization file is too large." };
    }
    const customization = parseCustomization(JSON.parse(raw) as unknown);
    return { customization, path, revision: hash(customization) };
  } catch (error) {
    return {
      ...empty,
      error: error instanceof Error ? error.message : "Invalid customization file.",
    };
  }
}

/**
 * Both UI requests and agent tools use this atomic writer. Agents may also
 * edit this exact JSON file directly; the renderer polls for external edits.
 */
export function writeCustomization(
  stateDir: string,
  input: unknown,
  expectedRevision?: string,
): CustomizationSnapshot {
  const customization = parseCustomization(input);
  const current = readCustomization(stateDir);
  if (expectedRevision !== undefined && expectedRevision !== "*" &&
    (current.error !== undefined || expectedRevision !== current.revision)) {
    throw new CustomizationConflictError();
  }
  const path = current.path;
  const temp = path + "." + NodeCrypto.randomUUID() + ".tmp";
  const serialized = JSON.stringify(customization, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > MAX_CUSTOMIZATION_BYTES) {
    throw new Error("Customization file exceeds the size limit.");
  }
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  try {
    NodeFS.writeFileSync(temp, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    NodeFS.renameSync(temp, path);
  } finally {
    NodeFS.rmSync(temp, { force: true });
  }
  return { customization, revision: hash(customization), path };
}
