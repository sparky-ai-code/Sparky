import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { __setPrimaryHttpRunnerForTests } from "../../lib/runtime";
import {
  clearPluginSession,
  invalidatePluginStatusCache,
  listPluginStatus,
  loadPersistedPluginSessionToken,
  persistPluginSessionToken,
  retryPendingPluginSessionRevocation,
} from "./pluginApi";

const sessionToken = "session-token-with-enough-length";
const firstStatuses = [{ pluginId: "gmail", connected: true, metadata: null }] as const;
const secondStatuses = [{ pluginId: "gmail", connected: false, metadata: null }] as const;

function installLocalStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  vi.stubGlobal("window", { localStorage: storage });
  return storage;
}

describe("plugin status cache", () => {
  afterEach(() => {
    invalidatePluginStatusCache();
    persistPluginSessionToken(null);
    __setPrimaryHttpRunnerForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hydrates the in-memory session from encrypted desktop storage", async () => {
    const storage = installLocalStorage();
    vi.stubGlobal("window", {
      localStorage: storage,
      desktopBridge: {
        getAccountSessionToken: async () => sessionToken,
      },
    });

    await expect(loadPersistedPluginSessionToken()).resolves.toBe(sessionToken);
    expect(storage.getItem("sparky.plugin-session.v1")).toBeNull();
  });

  it("reuses fresh status data across plugin pages", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ plugins: firstStatuses }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPluginStatus(sessionToken)).resolves.toEqual(firstStatuses);
    await expect(listPluginStatus(sessionToken)).resolves.toEqual(firstStatuses);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports an explicit refresh after an OAuth or disconnect change", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ plugins: firstStatuses }))
      .mockResolvedValueOnce(Response.json({ plugins: secondStatuses }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPluginStatus(sessionToken)).resolves.toEqual(firstStatuses);
    await expect(listPluginStatus(sessionToken, { forceRefresh: true })).resolves.toEqual(
      secondStatuses,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent status requests", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const firstRequest = listPluginStatus(sessionToken);
    const secondRequest = listPluginStatus(sessionToken);
    resolveResponse?.(Response.json({ plugins: firstStatuses }));

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
      firstStatuses,
      firstStatuses,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not revoke a replacement session during stale cleanup", async () => {
    installLocalStorage();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ revoked: true }));
    vi.stubGlobal("fetch", fetchMock);

    persistPluginSessionToken("replacement-session-token-with-enough-length");
    await clearPluginSession(sessionToken);

    expect(window.localStorage.getItem("sparky.plugin-session.v1")).toBe(
      "replacement-session-token-with-enough-length",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains a failed logout revocation for the next app launch", async () => {
    installLocalStorage();
    __setPrimaryHttpRunnerForTests(async () => {
      throw new Error("Local server unavailable.");
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Network unavailable."));
    vi.stubGlobal("fetch", fetchMock);

    persistPluginSessionToken(sessionToken);
    await clearPluginSession();

    expect(window.localStorage.getItem("sparky.plugin-session.v1")).toBeNull();
    expect(window.localStorage.getItem("sparky.plugin-session-revoke.v1")).toBe(
      JSON.stringify([sessionToken]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const retryFetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ revoked: true }));
    vi.stubGlobal("fetch", retryFetchMock);
    await retryPendingPluginSessionRevocation();
    await retryPendingPluginSessionRevocation();

    expect(retryFetchMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("sparky.plugin-session-revoke.v1")).toBeNull();
  });
});
