import { describe, expect, it } from "vite-plus/test";

import { CLAUDE_CODE_STOCK_MODELS } from "./Drivers/ClaudeCodeDriver.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("built-in providers", () => {
  it("registers Claude Code separately from Sparky's API models", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual(["sparky", "claudeAgent"]);
  });

  it("includes Fable in the Claude Code model choices", () => {
    expect(CLAUDE_CODE_STOCK_MODELS.map((model) => model.slug)).toContain("fable");
  });
});
