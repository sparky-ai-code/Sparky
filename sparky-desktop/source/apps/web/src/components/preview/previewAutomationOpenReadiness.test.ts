import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@sparky/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  preparePreviewAutomationOpen,
  previewAutomationOpenNeedsOverlay,
  previewAutomationOpenRequiresVisibility,
  previewAutomationOverlayReady,
} from "./previewAutomationOpenReadiness";

const snapshot = (navStatus: PreviewSessionSnapshot["navStatus"]): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab-1",
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-26T00:00:00.000Z",
});

describe("preview automation open readiness", () => {
  it("waits for the browser surface to become visible unless explicitly hidden", () => {
    expect(previewAutomationOpenRequiresVisibility({} as PreviewAutomationOpenInput)).toBe(true);
    expect(
      previewAutomationOpenRequiresVisibility({ show: false } as PreviewAutomationOpenInput),
    ).toBe(false);
  });

  it("navigates before waiting for the visible surface", async () => {
    const calls: string[] = [];
    await preparePreviewAutomationOpen({
      navigate: async () => {
        calls.push("navigate");
      },
      waitForOverlay: async () => {
        calls.push("visible");
      },
    });
    expect(calls).toEqual(["navigate", "visible"]);
  });

  it("requires a visible surface when showing a browser tab", () => {
    expect(previewAutomationOverlayReady(true, false, true)).toBe(false);
    expect(previewAutomationOverlayReady(true, true, true)).toBe(true);
    expect(previewAutomationOverlayReady(true, false, false)).toBe(true);
    expect(previewAutomationOverlayReady(false, true, false)).toBe(false);
  });

  it("waits for a visible blank tab's webview to register", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(true);
  });

  it("does not wait for a hidden blank tab", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        { show: false } as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(false);
  });

  it("waits when an empty tab is immediately given a URL", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        { url: "https://example.com" } as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(true);
  });

  it("waits for existing tabs that already have rendered content", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({
          _tag: "Success",
          url: "https://example.com/",
          title: "Example",
        }),
      ),
    ).toBe(true);
  });
});
