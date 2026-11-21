import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("built-in providers", () => {
  it("registers the aggregated Sparky provider and the separate Claude Code provider", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual(["sparky", "claudeAgent"]);
  });

  it("does not register any standalone native CLI driver beyond these two", () => {
    // Each registered driver owns a distinct provider surface. Adding a driver here
    // must be a deliberate change to this list.
    const kinds = new Set(BUILT_IN_DRIVERS.map((driver) => driver.driverKind));
    expect(kinds.size).toBe(BUILT_IN_DRIVERS.length);
  });
});
