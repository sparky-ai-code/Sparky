import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  hasCloudPublicConfig,
  resolveCloudPublicConfig,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it("requires Neon Auth and relay public values", () => {
    vi.stubEnv("VITE_NEON_AUTH_URL", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_NEON_AUTH_URL", "https://auth.example.test");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_NEON_AUTH_URL", "https://auth.example.test");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("normalizes the optional account API and authorization endpoints", () => {
    vi.stubEnv("VITE_NEON_AUTH_URL", "https://auth.example.test/");
    vi.stubEnv("VITE_NEON_AUTH_OAUTH_AUTHORIZE_URL", "https://auth.example.test/oauth/authorize");
    vi.stubEnv("VITE_NEON_AUTH_CLI_OAUTH_CLIENT_ID", " account-cli ");
    vi.stubEnv("VITE_ACCOUNT_API_URL", "https://accounts.example.test/");

    expect(resolveCloudPublicConfig()).toMatchObject({
      neonAuthUrl: "https://auth.example.test/",
      neonAuthOAuthAuthorizeUrl: "https://auth.example.test/oauth/authorize",
      neonAuthCliOAuthClientId: "account-cli",
      accountApiUrl: "https://accounts.example.test/",
    });
  });
});
