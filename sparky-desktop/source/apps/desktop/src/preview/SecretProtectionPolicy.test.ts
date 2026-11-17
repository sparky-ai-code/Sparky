import { describe, expect, it } from "vite-plus/test";
import { canClickProtectedPage, isCredentialSafeReadinessProbe, isProtectedInspectionAction } from "./SecretProtectionPolicy.ts";

describe("protected credential browser actions", () => {
  it("does not taint a page for the desktop's fixed navigation readiness probe", () => {
    expect(isCredentialSafeReadinessProbe("document.readyState")).toBe(true);
    for (const expression of [
      "document.readyState; window.evil = true",
      "(document.readyState)",
      "document.readyState + document.cookie",
      "document.querySelector('input[type=password]')?.value",
      "window.addEventListener('input', () => {})",
    ]) {
      expect(isCredentialSafeReadinessProbe(expression)).toBe(false);
    }
    // The exception only avoids pre-fill taint; once protected, all evaluation remains blocked.
    expect(isProtectedInspectionAction("evaluate")).toBe(true);
  });
  it("blocks inspection and recording after waiting on the tab lock", () => {
    for (const action of ["snapshot", "evaluate", "waitFor", "type", "press", "scroll", "recording.start"]) {
      expect(isProtectedInspectionAction(action)).toBe(true);
    }
    expect(isProtectedInspectionAction("click")).toBe(false);
    expect(isProtectedInspectionAction("saved-login")).toBe(false);
    expect(isProtectedInspectionAction("recording.stop")).toBe(false);
  });

  it("allows a submit button or fixed coordinates without DOM inspection", () => {
    expect(canClickProtectedPage({ locator: "role=button[name='Sign in']" })).toBe(true);
    expect(canClickProtectedPage({ locator: 'role=button[name="Log in"]' })).toBe(true);
    expect(canClickProtectedPage({ selector: "button[type=submit]" })).toBe(true);
    expect(canClickProtectedPage({ locator: "css=input[type='submit']" })).toBe(true);
    expect(canClickProtectedPage({ x: 300, y: 200 })).toBe(true);
  });

  it("rejects arbitrary CSS, locator expressions, and partial coordinates", () => {
    expect(canClickProtectedPage({ selector: "input[value^='a']" })).toBe(false);
    expect(canClickProtectedPage({ locator: "role=textbox[name='Password']" })).toBe(false);
    expect(canClickProtectedPage({ locator: "css=button:has(input[value^=a])" })).toBe(false);
    expect(canClickProtectedPage({ locator: "role=button[name=/password/]" })).toBe(false);
    expect(canClickProtectedPage({ x: 100 })).toBe(false);
    expect(canClickProtectedPage({ x: 100, y: 20, selector: "button" })).toBe(false);
  });
});
