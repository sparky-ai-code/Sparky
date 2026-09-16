import { describe, expect, it } from "vite-plus/test";

import { isModelInSparkyCatalog } from "./sparkyModelCatalog";

describe("isModelInSparkyCatalog", () => {
  it("shows both OpenAI API and ChatGPT subscription models in the OpenAI catalog", () => {
    expect(isModelInSparkyCatalog("catalog:OpenAI", "OpenAI")).toBe(true);
    expect(isModelInSparkyCatalog("catalog:OpenAI", "OpenAI Codex")).toBe(true);
  });

  it("keeps other providers out of the OpenAI catalog", () => {
    expect(isModelInSparkyCatalog("catalog:OpenAI", "Claude")).toBe(false);
    expect(isModelInSparkyCatalog("catalog:OpenAI", "Google")).toBe(false);
  });
});
