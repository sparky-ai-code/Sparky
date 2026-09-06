import { describe, expect, it } from "vite-plus/test";

import {
  InvalidNeonAuthUrlError,
  isAllowedNeonAuthHostname,
  neonAuthHostnameFromUrl,
  neonAuthUrl,
  relayAccountTokenOptions,
} from "./relayAuth.ts";

const captureError = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to throw");
};

describe("Neon Auth relay auth", () => {
  it("normalizes a Neon Auth origin and derives its hostname", () => {
    expect(neonAuthUrl("https://auth.example.test")).toBe("https://auth.example.test/");
    expect(neonAuthHostnameFromUrl("https://auth.example.test")).toBe("auth.example.test");
  });

  it("rejects insecure, credential-bearing, or non-origin URLs", () => {
    for (const value of [
      "http://auth.example.test",
      "https://user:password@auth.example.test",
      "https://auth.example.test/path",
      "not-a-url",
    ]) {
      const error = captureError(() => neonAuthUrl(value));
      expect(error).toBeInstanceOf(InvalidNeonAuthUrlError);
      expect(error).toMatchObject({ url: value });
    }
  });

  it("allows only the configured Neon Auth hostname", () => {
    expect(isAllowedNeonAuthHostname("auth.example.test", "auth.example.test")).toBe(true);
    expect(isAllowedNeonAuthHostname("attacker.example", "auth.example.test")).toBe(false);
    expect(isAllowedNeonAuthHostname("nested.auth.example.test", "auth.example.test")).toBe(false);
  });

  it("disables relay token caching for account token refreshes", () => {
    expect(relayAccountTokenOptions()).toEqual({ skipCache: true });
  });
});
