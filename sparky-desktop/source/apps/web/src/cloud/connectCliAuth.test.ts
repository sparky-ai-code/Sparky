import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildConnectCliAuthorizeUrl,
  hasConnectCliAuthConfig,
  readConnectCliCallbackResult,
} from "./connectCliAuth";

describe("connectCliAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires Neon Auth and the CLI OAuth client id", () => {
    vi.stubEnv("VITE_NEON_AUTH_URL", "https://auth.example.com");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.com");
    expect(hasConnectCliAuthConfig()).toBe(false);

    vi.stubEnv("VITE_NEON_AUTH_CLI_OAUTH_CLIENT_ID", "account-cli");
    expect(hasConnectCliAuthConfig()).toBe(true);
  });

  it("builds the Neon Auth authorize URL with the configured hosted origin's callback", () => {
    vi.stubEnv("VITE_NEON_AUTH_URL", "https://auth.example.com");
    vi.stubEnv("VITE_NEON_AUTH_OAUTH_AUTHORIZE_URL", "https://auth.example.com/oauth/authorize");
    vi.stubEnv("VITE_NEON_AUTH_CLI_OAUTH_CLIENT_ID", "account-cli");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://nightly.app.t3.codes");

    const authorizeUrl = buildConnectCliAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.hostname).toBe("auth.example.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://nightly.app.t3.codes/connect/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("returns null when the CLI OAuth client id is not configured", () => {
    vi.stubEnv("VITE_NEON_AUTH_URL", "https://auth.example.com");
    expect(buildConnectCliAuthorizeUrl({ state: "state-1", challenge: "challenge-1" })).toBeNull();
  });

  it("reads the code and state echoed back to the callback", () => {
    expect(
      readConnectCliCallbackResult(
        new URL("https://app.t3.codes/connect/callback?code=abc&state=state-1"),
      ),
    ).toEqual({ code: "abc", state: "state-1" });
    expect(
      readConnectCliCallbackResult(new URL("https://app.t3.codes/connect/callback?code=abc")),
    ).toBeNull();
    expect(
      readConnectCliCallbackResult(new URL("https://app.t3.codes/connect/callback?state=s")),
    ).toBeNull();
  });
});
