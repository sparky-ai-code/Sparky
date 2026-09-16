import * as Schema from "effect/Schema";

export class InvalidNeonAuthUrlError extends Schema.TaggedErrorClass<InvalidNeonAuthUrlError>()(
  "InvalidNeonAuthUrlError",
  {
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Neon Auth URL must be a secure origin.";
  }
}

export function neonAuthUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("invalid Neon Auth URL");
    }
    return parsed.toString();
  } catch (cause) {
    throw new InvalidNeonAuthUrlError({ url, cause });
  }
}

export function neonAuthHostnameFromUrl(url: string): string {
  return new URL(neonAuthUrl(url)).hostname;
}

export function isAllowedNeonAuthHostname(hostname: string, configuredHostname: string | null): boolean {
  return hostname === configuredHostname;
}

export function relayAccountTokenOptions() {
  return {
    skipCache: true,
  } as const;
}
