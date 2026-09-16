import { describe, expect, it } from "vite-plus/test";

import { PLUGINS } from "./pluginCatalog";

describe("Plugins page catalog layout", () => {
  it("starts with every plugin in Explore more when nothing is connected", () => {
    const connectedIds = new Set<string>();
    const installed = PLUGINS.filter((plugin) => connectedIds.has(plugin.id));
    const explore = PLUGINS.filter((plugin) => !connectedIds.has(plugin.id));

    expect(installed).toHaveLength(0);
    expect(explore).toHaveLength(PLUGINS.length);
  });

  it("moves connected plugins out of Explore more", () => {
    const connectedIds = new Set(["gmail", "figma"]);
    const installed = PLUGINS.filter((plugin) => connectedIds.has(plugin.id));
    const explore = PLUGINS.filter((plugin) => !connectedIds.has(plugin.id));

    expect(installed.map((plugin) => plugin.id)).toEqual(["gmail", "figma"]);
    expect(explore.some((plugin) => connectedIds.has(plugin.id))).toBe(false);
  });
});
