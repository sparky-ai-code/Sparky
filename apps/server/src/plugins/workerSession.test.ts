import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  SUPPORTED_PLUGIN_IDS,
  hasPluginSessionToken,
  isSupportedPluginId,
  setPluginSessionToken,
} from "./workerSession.js";

afterEach(() => setPluginSessionToken(null));

describe("plugin worker session", () => {
  it("supports exactly the shipped plugin ids", () => {
    expect(SUPPORTED_PLUGIN_IDS).toEqual([
      "github",
      "jira",
      "notion",
      "gmail",
      "outlook",
      "slack",
      "sentry",
      "figma",
    ]);
    expect(isSupportedPluginId("github")).toBe(true);
    expect(isSupportedPluginId("discord")).toBe(false);
  });

  it("accepts only opaque session-shaped tokens", () => {
    setPluginSessionToken("short");
    expect(hasPluginSessionToken()).toBe(false);

    setPluginSessionToken("valid-session-token-abcdefghijklmnopqrstuvwxyz");
    expect(hasPluginSessionToken()).toBe(true);

    setPluginSessionToken("invalid session token with spaces");
    expect(hasPluginSessionToken()).toBe(false);
  });
});
