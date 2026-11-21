import { createHash } from "node:crypto";

/**
 * Cua Driver (cua-driver-rs) is the computer-use backend the Windows installer
 * bundles so Sparky can drive the desktop without a separate install step.
 *
 * The release is pinned here, with the SHA-256 of each Windows zip taken from
 * the release's SHA256SUMS file. The build refuses to bundle any archive whose
 * hash does not match, so a changed or truncated download cannot ship silently.
 */
export const CUA_DRIVER_RS_VERSION = "0.56.4";
export const CUA_DRIVER_RELEASE_TAG = `cua-driver-rs-v${CUA_DRIVER_RS_VERSION}`;
export const CUA_DRIVER_EXECUTABLE_NAME = "cua-driver.exe";

export type CuaDriverWindowsArch = "x64" | "arm64";

export interface CuaDriverWindowsAsset {
  readonly arch: CuaDriverWindowsArch;
  readonly fileName: string;
  readonly sha256: string;
  readonly downloadUrl: string;
}

interface CuaDriverWindowsArchive {
  readonly fileName: string;
  readonly sha256: string;
}

const CUA_DRIVER_WINDOWS_ARCHIVES: Record<CuaDriverWindowsArch, CuaDriverWindowsArchive> = {
  x64: {
    fileName: `cua-driver-rs-${CUA_DRIVER_RS_VERSION}-windows-x86_64-binary.zip`,
    sha256: "7383e21168760907aea0cdf6b459b7f3157a384a2ebe6cf556cbbfee911a3374",
  },
  arm64: {
    fileName: `cua-driver-rs-${CUA_DRIVER_RS_VERSION}-windows-arm64-binary.zip`,
    sha256: "e7ab726154cda3a0150a6669058a1b8083615a7eac90ea611de4e7f7c795ee42",
  },
};

export function getCuaDriverWindowsAsset(arch: CuaDriverWindowsArch): CuaDriverWindowsAsset {
  const archive = CUA_DRIVER_WINDOWS_ARCHIVES[arch];
  return {
    arch,
    fileName: archive.fileName,
    sha256: archive.sha256,
    downloadUrl: `https://github.com/trycua/cua/releases/download/${CUA_DRIVER_RELEASE_TAG}/${archive.fileName}`,
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isExpectedCuaDriverArchive(bytes: Uint8Array, expectedSha256: string): boolean {
  return sha256Hex(bytes) === expectedSha256;
}
