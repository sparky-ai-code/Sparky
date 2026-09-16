import { describe, expect, it } from "vite-plus/test";

import {
  SUPPORTED_PLUGIN_IDS,
  isSupportedPluginId,
  normalizePluginSessionToken,
} from "./workerSession.js";
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
    expect(normalizePluginSessionToken("short")).toBeNull();

    const valid = "valid-session-token-abcdefghijklmnopqrstuvwxyz";
    expect(normalizePluginSessionToken(` ${valid} `)).toBe(valid);
    expect(normalizePluginSessionToken("invalid session token with spaces")).toBeNull();
  });
});
