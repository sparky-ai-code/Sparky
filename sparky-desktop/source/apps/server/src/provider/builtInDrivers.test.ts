import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("built-in providers", () => {
  it("registers Claude Code separately from Sparky's API models", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual(["sparky", "claudeAgent"]);
  });
});
