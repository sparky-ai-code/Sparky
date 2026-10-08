import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("built-in providers", () => {
  it("registers Sparky and the ACP harness drivers", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual([
      "sparky",
      "codexHarness",
      "claudeHarness",
      "acp",
    ]);
  });
});
