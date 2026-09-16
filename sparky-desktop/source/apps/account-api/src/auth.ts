// @effect-diagnostics globalDate:off
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import type { AccountApiConfig } from "./config.ts";

export interface AccountPrincipal {
  readonly userId: string;
  readonly sessionId?: string;
  readonly issuedAt?: Date;
  readonly expiresAt?: Date;
}

export class AccountAuthenticationError extends Error {
  constructor(message = "A valid Sparky account session is required.") {
    super(message);
    this.name = "AccountAuthenticationError";
  }
}

export function createAccountAuthenticator(config: AccountApiConfig) {
  const jwks = createRemoteJWKSet(new URL(config.authJwksUrl));

  return async (request: Request): Promise<AccountPrincipal> => {
    const authorization = request.headers.get("authorization") ?? "";
    const [scheme, token] = authorization.split(/\s+/, 2);
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new AccountAuthenticationError();
    }

    try {
      const verified = await jwtVerify(token, jwks, {
        issuer: config.authIssuer,
        ...(config.authAudience ? { audience: config.authAudience } : {}),
      });
      const userId = nonEmptyString(verified.payload.sub);
      if (!userId) {
        throw new AccountAuthenticationError("The account session has no user identity.");
      }

      return {
        userId,
        ...optionalClaimDate(verified.payload, "iat", "issuedAt"),
        ...optionalClaimDate(verified.payload, "exp", "expiresAt"),
        ...optionalClaimString(verified.payload, ["sid", "sessionId", "session_id"], "sessionId"),
      };
    } catch (error) {
      if (error instanceof AccountAuthenticationError) throw error;
      throw new AccountAuthenticationError();
    }
  };
}

function optionalClaimString(
  payload: JWTPayload,
  claims: ReadonlyArray<string>,
  key: "sessionId",
): Partial<AccountPrincipal> {
  for (const claim of claims) {
    const value = nonEmptyString(payload[claim]);
    if (value) return { [key]: value };
  }
  return {};
}

function optionalClaimDate(
  payload: JWTPayload,
  claim: "iat" | "exp",
  key: "issuedAt" | "expiresAt",
): Partial<AccountPrincipal> {
  const value = payload[claim];
  return typeof value === "number" && Number.isFinite(value)
    ? { [key]: new Date(value * 1_000) }
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
