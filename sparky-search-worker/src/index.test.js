import test from "node:test";
import assert from "node:assert/strict";
import { extractFaviconUrl, faviconUrlForOrigin, handleSearch, normalizeUrl, parseExaResults } from "./index.js";

const env = {
  EXA_API_KEY: "test-key",
  ALLOWED_ORIGINS: "https://sparky.llc",
  SEARCH_RATE_LIMITER: {
    async limit({ key }) {
      assert.equal(typeof key, "string");
      return { success: true };
    },
  },
};

function request(body, headers = {}) {
  return new Request("https://search.example/search", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("normalizes only http and https result URLs", () => {
  assert.equal(normalizeUrl("https://example.com/docs"), "https://example.com/docs");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(faviconUrlForOrigin("https://example.com/docs"), "https://example.com/favicon.ico");
});

test("extracts declared site icons and resolves relative URLs", () => {
  assert.equal(
    extractFaviconUrl(
      '<head><link rel="canonical" href="/" /><link rel="icon" type="image/svg+xml" href="/assets/icon.svg" /></head>',
      "https://example.com/docs/page",
    ),
    "https://example.com/assets/icon.svg",
  );
  assert.equal(
    extractFaviconUrl('<link rel="apple-touch-icon" href="icons/touch.png">', "https://example.com/docs"),
    "https://example.com/icons/touch.png",
  );
});

test("parses and deduplicates Exa results", () => {
  const results = parseExaResults(
    {
      results: [
        { title: "Docs", url: "https://example.com/docs", highlights: ["Useful docs"] },
        { title: "Duplicate", url: "https://example.com/docs" },
        { title: "Guide", url: "https://guide.example.org" },
      ],
    },
    5,
  );

  assert.deepEqual(results, [
    {
      title: "Docs",
      snippet: "Useful docs",
      url: "https://example.com/docs",
      favicon_url: "https://example.com/favicon.ico",
    },
    {
      title: "Guide",
      snippet: "",
      url: "https://guide.example.org/",
      favicon_url: "https://guide.example.org/favicon.ico",
    },
  ]);
});

test("accepts native search requests without plugin credentials", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });

  const response = await handleSearch(request({ query: "docs" }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { provider: "Exa", query: "docs", results: [] });
});

test("returns 429 when the Cloudflare rate limiter rejects a client", async () => {
  const response = await handleSearch(
    request({ query: "docs" }, { "CF-Connecting-IP": "203.0.113.10" }),
    {
      ...env,
      SEARCH_RATE_LIMITER: {
        async limit({ key }) {
          assert.equal(key, "203.0.113.10");
          return { success: false };
        },
      },
    },
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(await response.json(), { error: "rate_limited" });
});

test("returns an empty structured result for a malformed Exa payload", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ results: "not-an-array" }), { status: 200 });

  const response = await handleSearch(request({ query: "docs" }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { provider: "Exa", query: "docs", results: [] });
});
test("proxies Exa results without exposing the Exa secret", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.exa.ai/search") {
      assert.equal(init.headers["x-api-key"], "test-key");
      return new Response(
        JSON.stringify({ results: [{ title: "Docs", url: "https://example.com/docs" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("<html><head></head></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };

  const response = await handleSearch(request({ query: "docs" }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    provider: "Exa",
    query: "docs",
    results: [
      {
        title: "Docs",
        snippet: "",
        url: "https://example.com/docs",
        favicon_url: "https://example.com/favicon.ico",
      },
    ],
  });
});

test("enriches Exa results with the page-declared favicon", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) =>
    String(input) === "https://api.exa.ai/search"
      ? new Response(JSON.stringify({ results: [{ title: "Icon docs", url: "https://icon.example/docs" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : new Response('<link rel="shortcut icon" href="/brand/favicon.svg">', {
          status: 200,
          headers: { "content-type": "text/html" },
        });

  const response = await handleSearch(request({ query: "icon docs" }), env);
  const payload = await response.json();
  assert.equal(payload.results[0].favicon_url, "https://icon.example/brand/favicon.svg");
});

test("returns a clear failure when Exa is unavailable", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response("quota", { status: 429 });

  const response = await handleSearch(request({ query: "docs" }), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "exa_unavailable" });
});
