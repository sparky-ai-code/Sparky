import type { DesktopPreviewWebviewConfig } from "@sparky/contracts";

/**
 * A persistent Electron partition stores site data on disk; a partition without
 * the "persist:" prefix is isolated in memory and discarded when Sparky exits.
 */
export function browserProfilePartition(
  config: Pick<DesktopPreviewWebviewConfig, "partition" | "temporaryPartition">,
  persistentBrowserProfileEnabled: boolean,
): string {
  return persistentBrowserProfileEnabled ? config.partition : config.temporaryPartition;
}
