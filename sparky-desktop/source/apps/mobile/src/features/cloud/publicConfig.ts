import Constants from "expo-constants";
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
  readonly neonAuth: {
    readonly url: string | null;
  };
  readonly relay: {
    readonly url: string | null;
  };
  readonly observability: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | {
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    }
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeNeonAuthUrl(value: unknown): string | null {
  const normalized = normalizeSecureUrl(value);
  if (normalized === null) return null;
  try {
    return new URL(normalized).origin + "/";
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(extra: ExpoExtra = Constants.expoConfig?.extra) {
  return {
    neonAuth: {
      url: normalizeNeonAuthUrl(extra?.neonAuth?.url),
    },
    relay: {
      url: normalizeSecureRelayUrl(trimNonEmpty(extra?.relay?.url) ?? ""),
    },
    observability: {
      tracesUrl: normalizeSecureUrl(extra?.observability?.tracesUrl),
      tracesDataset: trimNonEmpty(extra?.observability?.tracesDataset),
      tracesToken: trimNonEmpty(extra?.observability?.tracesToken),
    },
  } satisfies CloudPublicConfig;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.neonAuth.url && config.relay.url);
}

type Configured<T> = {
  readonly [Key in keyof T]: NonNullable<T[Key]>;
};

type TracingPublicConfig = Omit<CloudPublicConfig, "observability"> & {
  readonly observability: Configured<CloudPublicConfig["observability"]>;
};

export function hasTracingPublicConfig(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): config is TracingPublicConfig {
  return Boolean(
    config.observability.tracesUrl &&
    config.observability.tracesDataset &&
    config.observability.tracesToken,
  );
}
