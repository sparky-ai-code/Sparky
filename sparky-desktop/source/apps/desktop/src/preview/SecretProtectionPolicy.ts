import type { PreviewAutomationClickInput } from "@sparky/contracts";

/**
 * A credential-bearing page is opaque to the agent. Only a click on a
 * previously-known sign-in button (or a coordinate click) is permitted.
 * Arbitrary selectors can be used as password-value presence oracles.
 */
export function canClickProtectedPage(input: PreviewAutomationClickInput): boolean {
  if (input.x !== undefined || input.y !== undefined) {
    return input.x !== undefined && input.y !== undefined &&
      input.locator === undefined && input.selector === undefined &&
      Number.isFinite(input.x) && Number.isFinite(input.y);
  }
  if (input.selector !== undefined && input.locator !== undefined) return false;
  const locator = input.locator ?? (input.selector === undefined ? null : `css=${input.selector}`);
  if (locator === null) return false;
  return /^role=button\[name=(?:"[^"\\\r\n]{1,120}"|'[^'\\\r\n]{1,120}')\]$/.test(locator) ||
    /^css=(?:button|input)\[type=(?:"submit"|'submit'|submit)\]$/.test(locator);
}

const BLOCKED_WHILE_PROTECTED = new Set([
  "snapshot", "evaluate", "waitFor", "type", "press", "scroll", "recording.start",
]);

/** Check this under the per-tab browser action lock, not just on entry. */
export function isProtectedInspectionAction(action: string): boolean {
  return BLOCKED_WHILE_PROTECTED.has(action);
}
