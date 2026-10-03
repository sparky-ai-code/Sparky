import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@sparky/contracts";

export async function preparePreviewAutomationOpen(options: {
  readonly navigate: (() => Promise<void>) | undefined;
  readonly waitForOverlay: (() => Promise<void>) | undefined;
}): Promise<void> {
  if (options.navigate) await options.navigate();
  if (options.waitForOverlay) await options.waitForOverlay();
}

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean {
  // A visible blank tab still needs its about:blank guest webview registered;
  // otherwise preview_open returns before a follow-up preview_navigate can use it.
  return input.show !== false || input.url !== undefined || snapshot.navStatus._tag !== "Idle";
}

export function previewAutomationOpenRequiresVisibility(
  input: PreviewAutomationOpenInput,
): boolean {
  return input.show !== false;
}

export function previewAutomationOverlayReady(
  available: boolean,
  visible: boolean,
  requireVisible: boolean,
): boolean {
  return available && (!requireVisible || visible);
}
