export const DESKTOP_ASAR_RUNTIME_FILES = [
  "node_modules/effect/dist/Context.js",
  "node_modules/@effect/platform-node/dist/NodeHttpClient.js",
] as const;

export function shouldBundleDesktopMainDependency(id: string): boolean {
  return (
    id.startsWith("@sparky/") ||
    id.startsWith("@effect/") ||
    id === "effect" ||
    id.startsWith("effect/")
  );
}

export function findMissingDesktopAsarRuntimeFiles(
  fileIsUnpacked: (filePath: string) => boolean,
): string[] {
  return DESKTOP_ASAR_RUNTIME_FILES.filter((filePath) => !fileIsUnpacked(filePath));
}
