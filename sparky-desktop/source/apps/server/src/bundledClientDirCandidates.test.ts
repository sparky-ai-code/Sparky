import { describe, expect, it } from "vite-plus/test";

import { bundledClientDirCandidates } from "./config.ts";

describe("bundledClientDirCandidates", () => {
  it("tries the unpacked sibling of a Windows app.asar bundle directory", () => {
    expect(
      bundledClientDirCandidates(
        "C:\\Program Files\\Sparky\\resources\\app.asar\\apps\\server\\dist",
      ),
    ).toEqual([
      "C:\\Program Files\\Sparky\\resources\\app.asar\\apps\\server\\dist",
      "C:\\Program Files\\Sparky\\resources\\app.asar.unpacked\\apps\\server\\dist",
    ]);
  });

  it("tries the unpacked sibling of a POSIX app.asar bundle directory", () => {
    expect(bundledClientDirCandidates("/opt/Sparky/resources/app.asar/apps/server/dist")).toEqual([
      "/opt/Sparky/resources/app.asar/apps/server/dist",
      "/opt/Sparky/resources/app.asar.unpacked/apps/server/dist",
    ]);
  });

  it("uses only the bundle directory when it is not inside an archive", () => {
    expect(bundledClientDirCandidates("/repo/apps/server/dist")).toEqual([
      "/repo/apps/server/dist",
    ]);
  });
});
