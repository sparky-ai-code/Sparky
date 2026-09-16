const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const MAX_QUERY_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 160;
const MAX_SNIPPET_LENGTH = 600;
const MAX_HTML_PREFIX_BYTES = 64 * 1024;
const FAVICON_TIMEOUT_MS = 4_000;
const SEARCH_RATE_LIMIT_PERIOD_SECONDS = 60;

function clampMaxResults(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS, Math.trunc(parsed)));
}

function trimTo(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function faviconUrlForOrigin(value) {
  const url = normalizeUrl(value);
  if (!url) return null;
  const origin = new URL(url).origin;
  return `${origin}/favicon.ico`;
}

function htmlAttribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "iu"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isIconRelation(value) {
  return typeof value === "string" && /(?:^|\s)icon(?:\s|$)/iu.test(value);
}

function isAppleTouchIconRelation(value) {
  return (
    typeof value === "string" &&
    /(?:^|\s)apple-touch-icon(?:-precomposed)?(?:\s|$)/iu.test(value)
  );
}

function resolveFaviconUrl(href, pageUrl) {
  if (typeof href !== "string" || !href.trim()) return null;
  try {
    return normalizeUrl(new URL(href.trim(), pageUrl).toString());
  } catch {
    return null;
  }
}

function extractFaviconUrl(html, pageUrl) {
  let appleTouchIcon = null;
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const relation = htmlAttribute(tag, "rel");
    const href = resolveFaviconUrl(htmlAttribute(tag, "href"), pageUrl);
    if (!href) continue;
    if (isIconRelation(relation)) return href;
    if (!appleTouchIcon && isAppleTouchIconRelation(relation)) appleTouchIcon = href;
  }
  return appleTouchIcon;
}

async function readHtmlPrefix(response, maxBytes) {
  if (!response.body) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function extractSiteFavicon(pageUrl, fallbackUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS);
  try {
    const response = await fetch(pageUrl, {
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "SparkySearch/1.0 (+https://sparky.llc)",
      },
      signal: controller.signal,
    });
    if (!response.ok) return fallbackUrl;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
      return fallbackUrl;
    }
    const resolvedPageUrl = normalizeUrl(response.url) ?? pageUrl;
    return extractFaviconUrl(await readHtmlPrefix(response, MAX_HTML_PREFIX_BYTES), resolvedPageUrl) ?? fallbackUrl;
  } catch {
    return fallbackUrl;
  } finally {
    clearTimeout(timeout);
  }
}

function exaSnippet(result) {
  const highlights = Array.isArray(result?.highlights) ? result.highlights : [];
  const highlight = highlights.find((value) => typeof value === "string");
  return trimTo(highlight ?? result?.text ?? "", MAX_SNIPPET_LENGTH);
}

function parseExaResults(payload, maxResults) {
  const results = [];
  const seenUrls = new Set();
  for (const result of Array.isArray(payload?.results) ? payload.results : []) {
    const url = normalizeUrl(result?.url);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    results.push({
      title: trimTo(result?.title, MAX_TITLE_LENGTH) || new URL(url).hostname,
      snippet: exaSnippet(result),
      url,
      favicon_url: normalizeUrl(result?.favicon) ?? faviconUrlForOrigin(url),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

function responseHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const configuredOrigins = String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowOrigin =
    requestOrigin && (configuredOrigins.length === 0 || configuredOrigins.includes(requestOrigin))
      ? requestOrigin
      : configuredOrigins[0] ?? "*";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function jsonResponse(request, env, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...responseHeaders(request, env),
      ...extraHeaders,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function allowSearchRequest(request, env) {
  const limiter = env.SEARCH_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") return null;
  const clientKey = request.headers.get("CF-Connecting-IP")?.trim() || "anonymous";
  const result = await limiter.limit({ key: clientKey });
  return result?.success === true;
}

async function searchExa(query, maxResults, apiKey) {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: maxResults,
      contents: { highlights: { maxCharacters: 400 } },
    }),
  });
  if (!response.ok) {
    throw new Error(`Exa returned HTTP ${response.status}`);
  }
  const results = parseExaResults(await response.json(), maxResults);
  return Promise.all(
    results.map(async (result) => ({
      ...result,
      favicon_url: await extractSiteFavicon(result.url, result.favicon_url),
    })),
  );
}

export async function handleSearch(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: responseHeaders(request, env) });
  if (request.method !== "POST") return jsonResponse(request, env, { error: "method_not_allowed" }, 405);
  let rateLimitAllowed;
  try {
    rateLimitAllowed = await allowSearchRequest(request, env);
  } catch {
    return jsonResponse(request, env, { error: "search_rate_limit_unavailable" }, 503);
  }
  if (rateLimitAllowed === null) {
    return jsonResponse(request, env, { error: "search_rate_limit_not_configured" }, 503);
  }
  if (!rateLimitAllowed) {
    return jsonResponse(
      request,
      env,
      { error: "rate_limited" },
      429,
      { "retry-after": String(SEARCH_RATE_LIMIT_PERIOD_SECONDS) },
    );
  }
  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse(request, env, { error: "invalid_json" }, 400);
  }

  const query = trimTo(input?.query, MAX_QUERY_LENGTH);
  if (!query) return jsonResponse(request, env, { error: "query_required" }, 400);
  const maxResults = clampMaxResults(input?.max_results);
  const apiKey = trimTo(env.EXA_API_KEY, 4_096);
  if (!apiKey) return jsonResponse(request, env, { error: "search_not_configured" }, 503);

  try {
    const results = await searchExa(query, maxResults, apiKey);
    return jsonResponse(request, env, { provider: "Exa", query, results });
  } catch {
    return jsonResponse(request, env, { error: "exa_unavailable" }, 503);
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/search") {
      return jsonResponse(request, env, { error: "not_found" }, 404);
    }
    return handleSearch(request, env);
  },
};

export { extractFaviconUrl, faviconUrlForOrigin, parseExaResults, normalizeUrl };
