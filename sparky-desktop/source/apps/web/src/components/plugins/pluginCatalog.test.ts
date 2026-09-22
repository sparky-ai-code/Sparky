import { describe, expect, it } from "vite-plus/test";

import {
  PLUGINS,
  getPluginById,
  replacePluginTokensWithNames,
  searchPlugins,
  serializePluginToken,
} from "./pluginCatalog";

describe("plugin catalog", () => {
  it("contains only the seven active integrations", () => {
    expect(PLUGINS.map((plugin) => plugin.id)).toEqual([
      "github",
      "jira",
      "notion",
      "gmail",
      "outlook",
      "slack",
      "sentry",
    ]);
  });

  it("serializes stable inline tokens and resolves their display names", () => {
    expect(serializePluginToken("github")).toBe("@plugin:github");
    expect(replacePluginTokensWithNames("Review this with @plugin:github.")).toBe(
      "Review this with GitHub.",
    );
    expect(replacePluginTokensWithNames("Keep @plugin:unknown untouched")).toBe(
      "Keep @plugin:unknown untouched",
    );
  });

  it("searches names, descriptions, and keywords", () => {
    expect(searchPlugins("micro")[0]?.id).toBe("outlook");
    expect(searchPlugins("monitor")[0]?.id).toBe("sentry");
    expect(searchPlugins("atlassian")[0]?.id).toBe("jira");
    expect(getPluginById("discord")).toBeNull();
  });
});
