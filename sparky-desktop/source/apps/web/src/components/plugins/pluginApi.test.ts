import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { __setPrimaryHttpRunnerForTests } from "../../lib/runtime";
import {
  clearPluginSession,
  createAnonymousPluginSession,
  invalidatePluginStatusCache,
  listPluginStatus,
  loadPersistedPluginSessionToken,
  persistPluginSessionToken,
  retryPendingPluginSessionRevocation,
  startPluginAuthorization,
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

  it("uses the native installation identity when creating an anonymous session", async () => {
    const storage = installLocalStorage();
    const browserCandidate = "123e4567-e89b-42d3-a456-426614174000";
    const stableInstallationId = "123e4567-e89b-42d3-a456-426614174001";
    storage.setItem("sparky.plugin-installation-id.v1", browserCandidate);
    const getOrCreatePluginInstallationId = vi.fn(async () => stableInstallationId);
    vi.stubGlobal("window", {
      localStorage: storage,
      desktopBridge: { getOrCreatePluginInstallationId },
    });
    __setPrimaryHttpRunnerForTests(async <A>() => ({ ready: true }) as A);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        sessionToken,
        user: { id: "guest-installation", email: null },
        anonymous: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createAnonymousPluginSession();

    expect(getOrCreatePluginInstallationId).toHaveBeenCalledWith(browserCandidate);
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      installationId: string;
    };
    expect(requestBody.installationId).toBe(stableInstallationId);
  });

  it("retries a failed authorization-service fetch before surfacing an error", async () => {
    const storage = installLocalStorage();
    vi.stubGlobal("window", { localStorage: storage, setTimeout });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        Response.json({
          pluginId: "gmail",
          status: "pending",
          authorizationUrl: "https://accounts.google.com/authorize",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(startPluginAuthorization(sessionToken, "gmail")).resolves.toMatchObject({
      status: "pending",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
