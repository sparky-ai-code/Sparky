import { CONNECT_OAUTH_SCOPES, DEFAULT_HOSTED_APP_URL } from "@sparky/shared/connectAuth";
import { normalizeSecureRelayUrl } from "@sparky/shared/relayUrl";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_NEON_AUTH_URL__: string | undefined;
declare const __T3CODE_BUILD_NEON_AUTH_OAUTH_AUTHORIZE_URL__: string | undefined;
declare const __T3CODE_BUILD_NEON_AUTH_CLI_OAUTH_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

const CLOUD_CLI_OAUTH_REDIRECT_URI = "http://127.0.0.1:34338/callback";
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function validateRelayUrl(value: string) {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue(Option.some(value), {
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__T3CODE_BUILD_RELAY_URL__) ?? "");
export const buildTimeNeonAuthUrl = readBuildTimeValue(
  typeof __T3CODE_BUILD_NEON_AUTH_URL__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_NEON_AUTH_URL__,
);
export const buildTimeNeonAuthOAuthAuthorizeUrl = readBuildTimeValue(
  typeof __T3CODE_BUILD_NEON_AUTH_OAUTH_AUTHORIZE_URL__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_NEON_AUTH_OAUTH_AUTHORIZE_URL__,
);
export const buildTimeNeonAuthCliOAuthClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_NEON_AUTH_CLI_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_NEON_AUTH_CLI_OAUTH_CLIENT_ID__,
);
export const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  const tracesUrl = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.nonEmptyString("T3CODE_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapOrFail(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

/**
 * Hosted app origin used for out-of-band OAuth on headless
 * machines. Overridable so staging/nightly builds can point their CLIs at a
 * matching hosted deployment.
 */
export const hostedAppUrlConfig = makePublicValueConfig(
  "T3CODE_HOSTED_APP_URL",
  DEFAULT_HOSTED_APP_URL,
).pipe(Config.mapOrFail(validateHostedAppUrl));

function validateHostedAppUrl(value: string) {
  try {
    const url = new URL(value);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid hosted app origin");
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue(Option.some(value), {
            message: "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
          }),
        ),
      ),
    );
  }
}

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.nonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

export interface CloudCliOAuthConfig {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig({
  neonAuthOAuthAuthorizeUrlFallback = buildTimeNeonAuthOAuthAuthorizeUrl,
  neonAuthCliOAuthClientIdFallback = buildTimeNeonAuthCliOAuthClientId,
}: {
  readonly neonAuthOAuthAuthorizeUrlFallback?: string;
  readonly neonAuthCliOAuthClientIdFallback?: string;
} = {}) {
  return Config.all({
    authorizationEndpoint: makePublicValueConfig(
      "T3CODE_NEON_AUTH_OAUTH_AUTHORIZE_URL",
      neonAuthOAuthAuthorizeUrlFallback,
    ),
    clientId: makePublicValueConfig(
      "T3CODE_NEON_AUTH_CLI_OAUTH_CLIENT_ID",
      neonAuthCliOAuthClientIdFallback,
    ),
  }).pipe(
    Config.map(({ authorizationEndpoint, clientId }) => {
      const tokenEndpoint = new URL(authorizationEndpoint);
      tokenEndpoint.pathname = tokenEndpoint.pathname.replace(/\/authorize\/?$/u, "/token");
      return {
        authorizationEndpoint,
        tokenEndpoint: tokenEndpoint.toString(),
        clientId,
        redirectUri: CLOUD_CLI_OAUTH_REDIRECT_URI,
        scopes: CLOUD_CLI_OAUTH_SCOPES,
      } satisfies CloudCliOAuthConfig;
    }),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export const hasCloudPublicConfig = Boolean(
  (process.env.T3CODE_RELAY_URL?.trim() || buildTimeRelayUrl) &&
  (process.env.T3CODE_NEON_AUTH_URL?.trim() || buildTimeNeonAuthUrl) &&
  (process.env.T3CODE_NEON_AUTH_OAUTH_AUTHORIZE_URL?.trim() || buildTimeNeonAuthOAuthAuthorizeUrl) &&
  (process.env.T3CODE_NEON_AUTH_CLI_OAUTH_CLIENT_ID?.trim() || buildTimeNeonAuthCliOAuthClientId),
);
