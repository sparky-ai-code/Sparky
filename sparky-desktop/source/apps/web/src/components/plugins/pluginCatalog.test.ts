import { describe, expect, it } from "vite-plus/test";

import {
  PLUGINS,
  getPluginById,
  replacePluginTokensWithNames,
  searchPlugins,
  serializePluginToken,
} from "./pluginCatalog";

describe("plugin catalog", () => {
  it("keeps GitHub as the only active marketplace connector", () => {
    expect(PLUGINS.map((plugin) => plugin.id)).toEqual(["github"]);
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

  it("searches the GitHub connector and excludes retired integrations", () => {
    expect(searchPlugins("pull request")[0]?.id).toBe("github");
    expect(searchPlugins("atlassian")).toEqual([]);
    expect(getPluginById("jira")).toBeNull();
  });
});
