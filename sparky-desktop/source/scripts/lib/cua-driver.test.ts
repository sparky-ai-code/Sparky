import { assert, describe, it } from "@effect/vitest";

import {
  CUA_DRIVER_EXECUTABLE_NAME,
  CUA_DRIVER_RELEASE_TAG,
  CUA_DRIVER_RS_VERSION,
  getCuaDriverWindowsAsset,
  isExpectedCuaDriverArchive,
  sha256Hex,
} from "./cua-driver.ts";

describe("cua-driver bundle pin", () => {
  it("pins the release tag to the pinned version", () => {
    assert.equal(CUA_DRIVER_RELEASE_TAG, `cua-driver-rs-v${CUA_DRIVER_RS_VERSION}`);
    assert.equal(CUA_DRIVER_EXECUTABLE_NAME, "cua-driver.exe");
  });

  it("resolves the x64 Windows binary archive and its download URL", () => {
    const asset = getCuaDriverWindowsAsset("x64");
    assert.equal(
      asset.fileName,
      `cua-driver-rs-${CUA_DRIVER_RS_VERSION}-windows-x86_64-binary.zip`,
    );
    assert.equal(
      asset.downloadUrl,
      `https://github.com/trycua/cua/releases/download/${CUA_DRIVER_RELEASE_TAG}/${asset.fileName}`,
    );
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  });

  it("resolves a distinct arm64 Windows binary archive", () => {
    const x64 = getCuaDriverWindowsAsset("x64");
    const arm64 = getCuaDriverWindowsAsset("arm64");
    assert.equal(
      arm64.fileName,
      `cua-driver-rs-${CUA_DRIVER_RS_VERSION}-windows-arm64-binary.zip`,
    );
    assert.notEqual(arm64.sha256, x64.sha256);
  });
});

describe("cua-driver archive verification", () => {
  it("computes the SHA-256 of archive bytes", () => {
    // SHA-256 of the empty input.
    assert.equal(
      sha256Hex(new Uint8Array()),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("accepts bytes whose hash matches the pinned value", () => {
    const bytes = new TextEncoder().encode("cua-driver");
    assert.isTrue(isExpectedCuaDriverArchive(bytes, sha256Hex(bytes)));
  });

  it("rejects bytes whose hash does not match, such as a truncated download", () => {
    const bytes = new TextEncoder().encode("cua-driver");
    const truncated = bytes.slice(0, 5);
    assert.isFalse(isExpectedCuaDriverArchive(truncated, sha256Hex(bytes)));
  });

  it("rejects the real pinned archive hash for any other content", () => {
    const asset = getCuaDriverWindowsAsset("x64");
    assert.isFalse(isExpectedCuaDriverArchive(new Uint8Array([1, 2, 3]), asset.sha256));
  });
});
