# Sparky Search Worker

Cloudflare Worker proxy for Exa search. The Exa API key stays in Cloudflare and is never shipped to Sparky clients. Search has one provider by design: if Exa is unavailable, Sparky reports that search is temporarily unavailable instead of silently switching engines.

## Production deployment

Run these commands from `sparky-search-worker` after authenticating Wrangler to the Cloudflare account that owns `sparky.llc`:

```powershell
npm install
npx wrangler whoami
npx wrangler secret put EXA_API_KEY
npm test
npm run deploy
```

When prompted for `EXA_API_KEY`, paste the Exa key into Wrangler's secure prompt. Never put it in `wrangler.toml`, source files, frontend settings, shell history, or CI logs. Repeat `wrangler secret put EXA_API_KEY` whenever the key is rotated.

The search Worker is a native Sparky service, not a plugin. It has no auth Worker dependency, KV binding, or per-user service-token setup. `wrangler.toml` disables `workers.dev` and provisions a Cloudflare Rate Limiting binding at 60 requests per client IP per minute. The zone route is the only production entry point; additional WAF rules can be layered on it.

The included route sends `https://sparky.llc/search` and `https://sparky.llc/search/*` to this Worker while the existing Pages site continues serving other paths. If the Worker is deployed on another hostname, set `SPARKY_SEARCH_WORKER_URL` to its `/search` endpoint in the server environment.

## Smoke test after deployment

Send a native search request to verify the route returns an Exa response:

```powershell
$body = '{"query":"official Cloudflare Workers documentation","max_results":3}'
Invoke-WebRequest https://sparky.llc/search -Method Post -ContentType 'application/json' -Body $body
```

Expected success shape:

```json
{"provider":"Exa","query":"...","results":[{"title":"...","snippet":"...","url":"https://...","favicon_url":"https://.../favicon.ico"}]}
```

A missing rate-limit binding or Exa secret returns `503`; an exhausted per-client window returns `429` with `Retry-After: 60`. Confirm the deployed Worker version, `EXA_API_KEY` secret, rate-limit binding, route, allowed origins, and Exa account quota when troubleshooting.

## Favicon behavior

For each Exa result, the Worker fetches a bounded HTML prefix from the result page and resolves its declared `rel="icon"` (or Apple touch icon) against the final page URL. If the page cannot be fetched or declares no icon, it returns Exa's favicon value when present, then the site's `/favicon.ico` candidate. The returned `favicon_url`, title, URL, and snippet are passed through the desktop `web_search` tool to the model and timeline without exposing the Exa key.
