import { describe, expect, it } from "vite-plus/test";

import { readAccountApiConfig } from "./config.ts";

describe("readAccountApiConfig", () => {
  const clerkEnv = {
    NEON_DATABASE_URL: "postgresql://user:password@ep-example.neon.tech/db?sslmode=require",
    CLERK_ISSUER: "https://clerk.example.com",
    CLERK_AUDIENCE: "sparky-account-api",
  };

  it("prefers Clerk verification settings for the account API", () => {
    expect(readAccountApiConfig(clerkEnv)).toMatchObject({
      databaseUrl: clerkEnv.NEON_DATABASE_URL,
      authJwksUrl: "https://clerk.example.com/.well-known/jwks.json",
      authIssuer: clerkEnv.CLERK_ISSUER,
      authAudience: clerkEnv.CLERK_AUDIENCE,
      authProvider: "clerk",
      host: "127.0.0.1",
      port: 8788,
      corsOrigin: "*",
    });
  });

  it("accepts an explicit Clerk JWKS URL without requiring an audience", () => {
    expect(
      readAccountApiConfig({
        ...clerkEnv,
        CLERK_JWKS_URL: "https://clerk.example.com/custom-jwks.json",
        CLERK_AUDIENCE: undefined,
      }),
    ).toMatchObject({
      authJwksUrl: "https://clerk.example.com/custom-jwks.json",
      authIssuer: clerkEnv.CLERK_ISSUER,
      authAudience: null,
      authProvider: "clerk",
    });
  });

  it("keeps legacy Neon Auth verification as a migration fallback", () => {
    const legacyEnv = {
      NEON_DATABASE_URL: clerkEnv.NEON_DATABASE_URL,
      NEON_AUTH_JWKS_URL: "https://auth.example.neon.tech/.well-known/jwks.json",
      NEON_AUTH_ISSUER: "https://auth.example.neon.tech",
      NEON_AUTH_AUDIENCE: "sparky-relay",
    };
    expect(readAccountApiConfig(legacyEnv)).toMatchObject({
      authJwksUrl: legacyEnv.NEON_AUTH_JWKS_URL,
      authIssuer: legacyEnv.NEON_AUTH_ISSUER,
      authAudience: legacyEnv.NEON_AUTH_AUDIENCE,
      authProvider: "neon",
    });
  });

  it("requires the database URL", () => {
    expect(() =>
      readAccountApiConfig({
        ...clerkEnv,
        NEON_DATABASE_URL: " ",
      }),
    ).toThrow("NEON_DATABASE_URL or DATABASE_URL is required");
  });

  it("requires Clerk or complete legacy Neon verification settings", () => {
    expect(() =>
      readAccountApiConfig({
        NEON_DATABASE_URL: clerkEnv.NEON_DATABASE_URL,
      }),
    ).toThrow("CLERK_ISSUER");
  });

  it("rejects invalid ports", () => {
    expect(() => readAccountApiConfig({ ...clerkEnv, PORT: "70000" })).toThrow(
      "PORT must be a valid TCP port",
    );
  });
});
