import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { invalidatePluginStatusCache, listPluginStatus } from "./pluginApi";

const sessionToken = "session-token-with-enough-length";
const firstStatuses = [{ pluginId: "gmail", connected: true, metadata: null }] as const;
const secondStatuses = [{ pluginId: "gmail", connected: false, metadata: null }] as const;

describe("plugin status cache", () => {
  afterEach(() => {
    invalidatePluginStatusCache();
    vi.restoreAllMocks();
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
});
