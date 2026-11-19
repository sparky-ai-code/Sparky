import type { DesktopUpdateChannel } from "@sparky/contracts";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;
const BETA_VERSION_PATTERN = /-beta\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function isBetaDesktopVersion(version: string): boolean {
  return BETA_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  if (isNightlyDesktopVersion(appVersion)) return "nightly";
  return isBetaDesktopVersion(appVersion) ? "beta" : "latest";
}
