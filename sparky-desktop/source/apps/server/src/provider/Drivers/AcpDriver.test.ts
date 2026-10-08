import { describe, expect, it } from "vite-plus/test";
import { parseArgs } from "./AcpDriver.ts";

describe("ACP command argument parsing", () => {
  it("preserves quoted substrings that start within an argument", () => {
    expect(parseArgs("--cwd=\"/path with spaces\" --label prefix' quoted'")).toEqual([
      "--cwd=/path with spaces",
      "--label",
      "prefix quoted",
    ]);
  });

  it("preserves explicitly empty arguments and empty input", () => {
    expect(parseArgs("one \"\" '' two")).toEqual(["one", "", "", "two"]);
    expect(parseArgs("")).toEqual([]);
  });
});
