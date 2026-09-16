import { normalizeSecureRelayUrl } from "@sparky/shared/relayUrl";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedErrorClass<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_NEON_AUTH_URL"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly neonAuthUrl: string | null;
  readonly neonAuthOAuthAuthorizeUrl: string | null;
  readonly neonAuthCliOAuthClientId: string | null;
  readonly accountApiUrl: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    neonAuthUrl: normalizeSecureUrl(
      (import.meta.env.VITE_NEON_AUTH_URL as string | undefined) ?? "",
    ),
    neonAuthOAuthAuthorizeUrl: normalizeSecureUrl(
      (import.meta.env.VITE_NEON_AUTH_OAUTH_AUTHORIZE_URL as string | undefined) ?? "",
    ),
    neonAuthCliOAuthClientId: trimNonEmpty(
      import.meta.env.VITE_NEON_AUTH_CLI_OAUTH_CLIENT_ID as string | undefined,
    ),
    accountApiUrl: normalizeSecureUrl(
      (import.meta.env.VITE_ACCOUNT_API_URL as string | undefined) ?? "",
    ),
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

export function resolveRelayTracingConfig() {
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.neonAuthUrl && config.relayUrl);
}
