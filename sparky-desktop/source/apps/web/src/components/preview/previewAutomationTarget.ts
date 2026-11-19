import type { PreviewSessionSnapshot } from "@sparky/contracts";

interface PreviewAutomationSessionIndex {
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
}

export function needsPreviewAutomationSessionSync(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
): boolean {
  return (
    Object.keys(state.sessions).length === 0 ||
    requestedTabId === undefined ||
    state.sessions[requestedTabId] === undefined
  );
}

export function resolvePreviewAutomationTarget(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | null,
): { readonly tabId: string | null; readonly snapshot: PreviewSessionSnapshot | null } {
  const snapshot = requestedTabId ? (state.sessions[requestedTabId] ?? null) : state.snapshot;
  return { tabId: snapshot?.tabId ?? null, snapshot };
}

export function resolvePreviewAutomationOpenTab(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
  reuseExistingTab: boolean,
): string | null {
  if (!reuseExistingTab) return null;
  // The broker supplies a tabId after this provider session has claimed one.
  // Without that claim, do not silently borrow the UI's currently selected tab:
  // opening should create one dedicated tab that can then be reused by the broker.
  if (requestedTabId === undefined) return null;
  return state.sessions[requestedTabId]?.tabId ?? null;
}
