export interface AccountApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly authJwksUrl: string;
  readonly authIssuer: string;
  readonly authAudience: string | null;
  readonly authProvider: "clerk" | "neon";
  readonly corsOrigin: string;
}

export function readAccountApiConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AccountApiConfig {
  const databaseUrl = firstNonEmpty(env, "NEON_DATABASE_URL", "DATABASE_URL");
  if (!databaseUrl) {
    throw new Error("NEON_DATABASE_URL or DATABASE_URL is required for the account API.");
  }

  const clerkIssuer = firstNonEmpty(env, "CLERK_ISSUER");
  const clerkJwksUrl =
    firstNonEmpty(env, "CLERK_JWKS_URL") ??
    (clerkIssuer ? `${clerkIssuer.replace(/\/$/u, "")}/.well-known/jwks.json` : undefined);
  const clerkAudience = firstNonEmpty(env, "CLERK_AUDIENCE") ?? null;

  const neonAuthJwksUrl = firstNonEmpty(env, "NEON_AUTH_JWKS_URL");
  const neonAuthIssuer = firstNonEmpty(env, "NEON_AUTH_ISSUER");
  const neonAuthAudience = firstNonEmpty(env, "NEON_AUTH_AUDIENCE");

  let authJwksUrl: string;
  let authIssuer: string;
  let authAudience: string | null;
  let authProvider: "clerk" | "neon";
  if (clerkIssuer && clerkJwksUrl) {
    authJwksUrl = clerkJwksUrl;
    authIssuer = clerkIssuer;
    authAudience = clerkAudience;
    authProvider = "clerk";
  } else if (neonAuthJwksUrl && neonAuthIssuer && neonAuthAudience) {
    // Legacy fallback keeps existing deployments operational while production
    // configuration is moved to Clerk.
    authJwksUrl = neonAuthJwksUrl;
    authIssuer = neonAuthIssuer;
    authAudience = neonAuthAudience;
    authProvider = "neon";
  } else {
    throw new Error(
      "CLERK_ISSUER (and optionally CLERK_JWKS_URL/CLERK_AUDIENCE) is required for the account API. Legacy NEON_AUTH_* settings remain supported during migration.",
    );
  }

  const portValue = Number(env.PORT ?? "8788");
  if (!Number.isInteger(portValue) || portValue <= 0 || portValue > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: portValue,
    databaseUrl,
    authJwksUrl,
    authIssuer,
    authAudience,
    authProvider,
    corsOrigin: env.SPARKY_ACCOUNT_CORS_ORIGIN?.trim() || "*",
  };
}

function firstNonEmpty(
  env: Readonly<Record<string, string | undefined>>,
  ...names: ReadonlyArray<string>
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
