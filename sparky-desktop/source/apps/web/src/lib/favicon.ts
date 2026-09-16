/**
 * Favicon helpers for preview tabs and web-search source badges.
 *
 * Favicon candidates start with the site's own `/favicon.ico`, then use Google's
 * favicon service for sites that publish a non-standard icon path. Callers
 * should always render a fallback when every candidate fails.
 */
const FAVICON_PROVIDER = "https://www.google.com/s2/favicons";

export function faviconUrlForOrigin(rawUrl: string | null | undefined, size = 32): string | null {
  return faviconUrlsForOrigin(rawUrl, size).at(-1) ?? null;
}

export function faviconUrlsForOrigin(rawUrl: string | null | undefined, size = 32): string[] {
  if (!rawUrl) return [];
  try {
    const url = new URL(rawUrl);
    if (!url.host || (url.protocol !== "http:" && url.protocol !== "https:")) return [];
    const origin = url.origin;
    return [
      `${origin}/favicon.ico`,
      `${FAVICON_PROVIDER}?domain_url=${encodeURIComponent(origin)}&sz=${size}`,
      `${FAVICON_PROVIDER}?domain=${encodeURIComponent(url.host)}&sz=${size}`,
    ];
  } catch {
    return [];
  }
}
