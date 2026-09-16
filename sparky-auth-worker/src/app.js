import { handleRequest, PLUGIN_IDS } from "./index.js";

const MAX_BODY_BYTES = 64 * 1024;
const ANALYTICS_PREFIX = "analytics:user:";
const FIGMA_TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const FIGMA_REFRESH_URL = "https://api.figma.com/v1/oauth/refresh";
const FIGMA_AUTHORIZE_URL = "https://www.figma.com/oauth";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

function securityHeaders() {
  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  };
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: securityHeaders() });
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function requireStore(env) {
  if (!env.PLUGIN_STORE || typeof env.PLUGIN_STORE.get !== "function") {
    throw new Error("PLUGIN_STORE KV binding is not configured.");
  }
  return env.PLUGIN_STORE;
}

async function bestEffortDelete(store, key) {
  // Cleanup must not break a valid request when the KV account has exhausted
  // its daily delete allowance.
  await store.delete(key).catch(() => undefined);
}

function requireEncryptionSecret(env) {
  const secret = env.PLUGIN_TOKEN_ENCRYPTION_KEY?.trim();
  if (!secret) throw new Error("PLUGIN_TOKEN_ENCRYPTION_KEY is not configured.");
  return secret;
}

function requireFigmaConfig(env) {
  const clientId = env.FIGMA_CLIENT_ID?.trim();
  const clientSecret = env.FIGMA_CLIENT_SECRET?.trim();
  if (!clientId) throw new Error("FIGMA_CLIENT_ID is not configured.");
  if (!clientSecret) throw new Error("FIGMA_CLIENT_SECRET is not configured.");
  return { clientId, clientSecret };
}

async function authenticatePluginSession(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (token.length < 20 || token.length > 4096 || /\s/u.test(token)) return null;
  const session = await requireStore(env).get(`session:${await sha256(token)}`, "json");
  if (!session || typeof session.userId !== "string") return null;
  return {
    userId: session.userId,
    email: typeof session.email === "string" ? session.email : null,
  };
}

async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error("Request body is too large.");
  }
  if (!text.trim()) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value;
}

async function encryptionKey(env) {
  const bytes = base64UrlToBytes(requireEncryptionSecret(env));
  if (bytes.byteLength !== 32) {
    throw new Error("PLUGIN_TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptRecord(value, env) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    version: 1,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
}

async function decryptRecord(serialized, env) {
  const envelope = JSON.parse(serialized);
  if (
    envelope?.version !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Stored plugin credential is invalid.");
  }
  const cleartext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv) },
    await encryptionKey(env),
    base64UrlToBytes(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(cleartext));
}

function figmaConnectionKey(userId) {
  return `connection:${userId}:figma`;
}

async function readFigmaConnection(env, userId) {
  const serialized = await requireStore(env).get(figmaConnectionKey(userId));
  if (!serialized) return null;
  try {
    return await decryptRecord(serialized, env);
  } catch {
    // Do not delete malformed records on every status poll. They can expire
    // or be replaced by a later successful authorization.
    return null;
  }
}

async function saveFigmaConnection(env, userId, connection) {
  await requireStore(env).put(figmaConnectionKey(userId), await encryptRecord(connection, env));
}

function normalizeFigmaToken(value, existingRefreshToken = null, existingMetadata = {}) {
  if (typeof value?.access_token !== "string" || value.access_token.length < 10) {
    throw new Error("Figma did not return an access token.");
  }
  const expiresIn = Number(value.expires_in);
  return {
    accessToken: value.access_token,
    refreshToken:
      typeof value.refresh_token === "string" ? value.refresh_token : existingRefreshToken,
    tokenType: typeof value.token_type === "string" ? value.token_type : "bearer",
    scope: typeof value.scope === "string" ? value.scope : "",
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    metadata: {
      ...existingMetadata,
      ...(typeof value.user_id_string === "string" ? { userId: value.user_id_string } : {}),
    },
  };
}

function figmaBasicAuth(config) {
  return `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
}

function workerBaseUrl(request, env) {
  if (env.PUBLIC_BASE_URL?.trim()) return env.PUBLIC_BASE_URL.trim().replace(/\/$/u, "");
  return new URL(request.url).origin;
}

async function startFigmaAuthorization(request, env, session) {
  const config = requireFigmaConfig(env);
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = await sha256(verifier);
  const redirectUri = `${workerBaseUrl(request, env)}/v1/plugins/figma/callback`;
  const store = requireStore(env);
  await store.put(
    `oauth:${state}`,
    JSON.stringify({
      userId: session.userId,
      pluginId: "figma",
      redirectUri,
      verifier,
      createdAt: Date.now(),
    }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );
  await store.put(`cancel:${session.userId}:figma`, "0", { expirationTtl: OAUTH_STATE_TTL_SECONDS });
  const url = new URL(FIGMA_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set(
    "scope",
    "current_user:read,file_content:read,file_comments:read,file_comments:write",
  );
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return json({ pluginId: "figma", status: "pending", authorizationUrl: url.toString() });
}

function oauthCallbackHtml(pluginId, ok) {
  const title = ok ? "Connected to Sparky" : "Sparky authorization failed";
  const message = ok
    ? `${pluginId} is connected. You can close this window.`
    : "Authorization did not complete. Return to Sparky and try again.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:460px;padding:32px;text-align:center"><h1 style="font-size:20px">${title}</h1><p style="opacity:.72">${message}</p></main></body></html>`;
}

function oauthCallbackResponse(pluginId, ok, status = ok ? 200 : 400) {
  return new Response(oauthCallbackHtml(pluginId, ok), {
    status,
    headers: { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handleFigmaCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) return oauthCallbackResponse("figma", false);
  const store = requireStore(env);
  const pending = await store.get(`oauth:${state}`, "json");
  await bestEffortDelete(store, `oauth:${state}`);
  if (
    !pending ||
    pending.pluginId !== "figma" ||
    typeof pending.userId !== "string" ||
    typeof pending.redirectUri !== "string" ||
    typeof pending.verifier !== "string"
  ) {
    return oauthCallbackResponse("figma", false);
  }
  try {
    const config = requireFigmaConfig(env);
    const response = await fetch(FIGMA_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: figmaBasicAuth(config),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        redirect_uri: pending.redirectUri,
        code,
        grant_type: "authorization_code",
        code_verifier: pending.verifier,
      }),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("Figma token exchange failed.");
    await saveFigmaConnection(env, pending.userId, normalizeFigmaToken(value));
    return oauthCallbackResponse("figma", true);
  } catch {
    return oauthCallbackResponse("figma", false, 502);
  }
}

async function ensureFigmaConnectionFresh(env, session) {
  const connection = await readFigmaConnection(env, session.userId);
  if (!connection || typeof connection.expiresAt !== "number") return;
  if (connection.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS) return;
  if (typeof connection.refreshToken !== "string" || !connection.refreshToken) return;
  const config = requireFigmaConfig(env);
  const response = await fetch(FIGMA_REFRESH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: figmaBasicAuth(config),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ refresh_token: connection.refreshToken }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Figma token refresh failed.");
  await saveFigmaConnection(
    env,
    session.userId,
    normalizeFigmaToken(value, connection.refreshToken, connection.metadata ?? {}),
  );
}

function cleanDimension(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^A-Za-z0-9._:/ -]/gu, "").slice(0, 120) || null;
}

function emptyAnalytics(userId, now = new Date().toISOString()) {
  return {
    userId,
    signedUpAt: now,
    lastSeenAt: now,
    prompts: 0,
    modelCalls: 0,
    models: {},
    providers: {},
  };
}

async function readAnalytics(env, userId) {
  return (
    (await requireStore(env).get(`${ANALYTICS_PREFIX}${userId}`, "json")) ??
    emptyAnalytics(userId)
  );
}

async function touchAnalytics(env, userId) {
  const current = await readAnalytics(env, userId);
  const next = { ...current, lastSeenAt: new Date().toISOString() };
  await requireStore(env).put(`${ANALYTICS_PREFIX}${userId}`, JSON.stringify(next));
  return next;
}

async function recordAnalytics(request, env, session) {
  const body = await readJson(request);
  if (body.type !== "prompt" && body.type !== "model_call") {
    return json({ error: "Unsupported analytics event." }, 400);
  }
  const current = await readAnalytics(env, session.userId);
  const model = cleanDimension(body.model);
  const provider = cleanDimension(body.provider);
  const now = new Date().toISOString();
  const next = {
    ...current,
    lastSeenAt: now,
    prompts: current.prompts + (body.type === "prompt" ? 1 : 0),
    modelCalls: current.modelCalls + (body.type === "model_call" ? 1 : 0),
    models: { ...current.models },
    providers: { ...current.providers },
  };
  if (body.type === "model_call" && model) {
    next.models[model] = (Number(next.models[model]) || 0) + 1;
  }
  if (body.type === "model_call" && provider) {
    next.providers[provider] = (Number(next.providers[provider]) || 0) + 1;
  }
  await requireStore(env).put(`${ANALYTICS_PREFIX}${session.userId}`, JSON.stringify(next));
  return json({ ok: true });
}

async function pendingPluginRequests(env, session) {
  const store = requireStore(env);
  const pending = [];
  for (const pluginId of PLUGIN_IDS) {
    const requestedKey = `requested:${session.userId}:${pluginId}`;
    const requestedAt = await store.get(requestedKey);
    if (!requestedAt) continue;
    const [connection, cancelled] = await Promise.all([
      store.get(`connection:${session.userId}:${pluginId}`),
      store.get(`cancel:${session.userId}:${pluginId}`),
    ]);
    if (connection || cancelled) {
      await bestEffortDelete(store, requestedKey);
      continue;
    }
    pending.push({ pluginId, requestedAt: Number(requestedAt) || null });
  }
  return json({ pending });
}

function adminAuthorized(request, env) {
  const expected = env.ANALYTICS_ADMIN_TOKEN?.trim();
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

async function analyticsReport(request, env) {
  if (!adminAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
  const store = requireStore(env);
  const users = [];
  let cursor;
  do {
    const page = await store.list({ prefix: ANALYTICS_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const record = await store.get(key.name, "json");
      if (record && typeof record.userId === "string") users.push(record);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const totals = users.reduce(
    (sum, user) => ({
      users: sum.users + 1,
      prompts: sum.prompts + (Number(user.prompts) || 0),
      modelCalls: sum.modelCalls + (Number(user.modelCalls) || 0),
    }),
    { users: 0, prompts: 0, modelCalls: 0 },
  );
  users.sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)));
  return json({ totals, users });
}

async function handleWrappedRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: securityHeaders() });
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/analytics") {
    return analyticsReport(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/plugins/figma/authorize") {
    const session = await authenticatePluginSession(request, env);
    if (!session) return json({ error: "Plugin session is invalid or expired." }, 401);
    return startFigmaAuthorization(request, env, session);
  }

  if (request.method === "GET" && url.pathname === "/v1/plugins/figma/callback") {
    return handleFigmaCallback(request, env);
  }

  if (url.pathname === "/v1/plugins/pending" || url.pathname === "/v1/analytics/events") {
    const session = await authenticatePluginSession(request, env);
    if (!session) return json({ error: "Plugin session is invalid or expired." }, 401);
    if (request.method === "GET" && url.pathname === "/v1/plugins/pending") {
      return pendingPluginRequests(env, session);
    }
    if (request.method === "POST" && url.pathname === "/v1/analytics/events") {
      try {
        return await recordAnalytics(request, env, session);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Analytics event failed." }, 400);
      }
    }
    return json({ error: "Not found." }, 404);
  }

  if (request.method === "GET" && url.pathname === "/v1/plugins") {
    const session = await authenticatePluginSession(request, env);
    if (session) await ensureFigmaConnectionFresh(env, session).catch(() => undefined);
  }

  if (request.method === "POST" && url.pathname === "/v1/mcp") {
    const session = await authenticatePluginSession(request, env);
    if (session) {
      const message = await readJson(request.clone()).catch(() => null);
      if (
        message?.method === "tools/call" &&
        message.params?.name === "sparky_plugin_call" &&
        message.params?.arguments?.pluginId === "figma"
      ) {
        await ensureFigmaConnectionFresh(env, session);
      }
    }
  }

  const callback =
    request.method === "GET"
      ? url.pathname.match(/^\/v1\/plugins\/([a-z]+)\/callback$/u)
      : null;
  const response = await handleRequest(request, env);

  if (callback && PLUGIN_IDS.includes(callback[1]) && callback[1] !== "github") {
    // Preserve the provider-specific callback response from index.js. Replacing
    // it here hides the actual token-exchange error behind a generic message.
    return response;
  }

  if (request.method === "POST" && url.pathname === "/v1/session" && response.ok) {
    try {
      const value = await response.clone().json();
      if (value?.user?.id && typeof value.user.id === "string") {
        await touchAnalytics(env, value.user.id);
      }
    } catch {
      // Authentication must not fail because analytics bookkeeping failed.
    }
  }
  return response;
}

export default {
  fetch(request, env) {
    return handleWrappedRequest(request, env).catch((error) =>
      json({ error: error instanceof Error ? error.message : "Worker request failed." }, 500),
    );
  },
};

export {
  cleanDimension,
  emptyAnalytics,
  ensureFigmaConnectionFresh,
  handleWrappedRequest,
  normalizeFigmaToken,
};
