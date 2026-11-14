import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CUSTOMIZATION } from "@sparky/shared/customization";

vi.mock("./environments/primary/httpLayer", () => ({
  fetchPrimaryEnvironment: vi.fn(),
}));
vi.mock("./environments/primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: (pathname: string) => "http://localhost:3773" + pathname,
}));
import { fetchPrimaryEnvironment } from "./environments/primary/httpLayer";
import {
  isCustomizationSafeMode, refreshCustomization, resetCustomizationForTests,
  saveCustomization, setCustomizationSnapshot,
} from "./customization";

const fetchMock = vi.mocked(fetchPrimaryEnvironment);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetCustomizationForTests();
});

describe("customization client sync", () => {
  it("reads the authenticated server snapshot and applies it", async () => {
    const customized = { ...DEFAULT_CUSTOMIZATION, name: "Ocean", tokens: { "--primary": "#38bdf8" } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      customization: customized, revision: "rev-1", path: "/state/customization.json",
    }), { status: 200 }));
    const result = await refreshCustomization(true);
    expect(result.customization.name).toBe("Ocean");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3773/api/sparky/customization",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("submits optimistic revisions and reports conflicts", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: "Customization changed in another session.",
    }), { status: 409 }));
    await expect(saveCustomization(DEFAULT_CUSTOMIZATION, "stale")).rejects.toThrow(
      "Customization changed in another session.",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3773/api/sparky/customization",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ customization: DEFAULT_CUSTOMIZATION, expectedRevision: "stale" }),
      }),
    );
  });

  it("does not accept an invalid snapshot that bypassed server validation", () => {
    expect(() => setCustomizationSnapshot({
      customization: { ...DEFAULT_CUSTOMIZATION, css: 'body{background:url(https://evil.example)}' },
      revision: "bad", path: "",
    })).toThrow("Custom CSS");
  });

  it("recognizes recovery mode in web and Electron hash routes", () => {
    vi.stubGlobal("window", { location: { search: "?safe-ui=1", hash: "" } });
    expect(isCustomizationSafeMode()).toBe(true);
    vi.stubGlobal("window", { location: { search: "?foo=bar", hash: "#/settings/appearance?safe-ui=1" } });
    expect(isCustomizationSafeMode()).toBe(true);
    vi.stubGlobal("window", { location: { search: "", hash: "#/settings/appearance" } });
    expect(isCustomizationSafeMode()).toBe(false);
  });

  it("does not let an older refresh roll back a successful save", async () => {
    let completeRead: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      completeRead = resolve;
    }));
    const previousRead = refreshCustomization(true);
    const updated = { ...DEFAULT_CUSTOMIZATION, name: "Current" };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      customization: updated, revision: "new-rev", path: "/state/customization.json",
    }), { status: 200 }));
    await saveCustomization(updated, "old-rev");
    completeRead?.(new Response(JSON.stringify({
      customization: DEFAULT_CUSTOMIZATION, revision: "old-rev", path: "/state/customization.json",
    }), { status: 200 }));
    expect((await previousRead).customization.name).toBe("Current");
  });
});
