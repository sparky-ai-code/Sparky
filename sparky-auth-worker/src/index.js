const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const AUTH_WAIT_MS = 55_000;
const AUTH_POLL_MS = 750;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const PLUGIN_IDS = ["github", "jira", "notion", "gmail", "outlook", "slack", "sentry", "figma"];
const jwksCache = new Map();

const PROVIDERS = {
  gmail: {
    label: "Gmail",
    clientId: "GMAIL_CLIENT_ID",
    clientSecret: "GMAIL_CLIENT_SECRET",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
    pkce: true,
  },
  outlook: {
    label: "Outlook",
    clientId: "OUTLOOK_CLIENT_ID",
    clientSecret: "OUTLOOK_CLIENT_SECRET",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"],
    pkce: true,
  },
  slack: {
    label: "Slack",
    clientId: "SLACK_CLIENT_ID",
    clientSecret: "SLACK_CLIENT_SECRET",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: ["channels:read", "channels:history", "groups:read", "groups:history", "chat:write", "users:read"],
    pkce: false,
  },
  jira: {
    label: "Jira",
    clientId: "JIRA_CLIENT_ID",
    clientSecret: "JIRA_CLIENT_SECRET",
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: ["read:jira-work", "write:jira-work", "read:jira-user", "offline_access"],
    pkce: false,
  },
  notion: {
    label: "Notion",
    clientId: "NOTION_CLIENT_ID",
    clientSecret: "NOTION_CLIENT_SECRET",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    pkce: false,
  },
  sentry: {
    label: "Sentry",
    clientId: "SENTRY_CLIENT_ID",
    clientSecret: "SENTRY_CLIENT_SECRET",
    authorizeUrl: "https://sentry.io/oauth/authorize/",
    tokenUrl: "https://sentry.io/oauth/token/",
    scopes: ["org:read", "project:read", "event:read", "event:write"],
    pkce: true,
  },
  figma: {
    label: "Figma",
    clientId: "FIGMA_CLIENT_ID",
    clientSecret: "FIGMA_CLIENT_SECRET",
    authorizeUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    scopes: ["current_user:read", "file_content:read", "file_comments:read", "file_comments:write"],
    pkce: true,
  },
};

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

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, { status, headers: { ...securityHeaders(), ...extraHeaders } });
}

function fail(message, status = 400, code = "bad_request") {
  return json({ error: message, code }, status);
}

function requireStore(env) {
  if (!env.PLUGIN_STORE || typeof env.PLUGIN_STORE.get !== "function") {
    throw new Error("PLUGIN_STORE KV binding is not configured.");
  }
  return env.PLUGIN_STORE;
}

async function bestEffortDelete(store, key) {
  // KV deletion is cleanup only. A daily delete quota failure must not make
  // status reads, OAuth callbacks, or a newly authorized connection fail.
  await store.delete(key).catch(() => undefined);
}

function requireEncryptionSecret(env) {
  const secret = env.PLUGIN_TOKEN_ENCRYPTION_KEY?.trim();
  if (!secret) throw new Error("PLUGIN_TOKEN_ENCRYPTION_KEY is not configured.");
  return secret;
}

function requireGitHubConfig(env) {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  if (!clientId || clientId === "REPLACE_WITH_GITHUB_APP_CLIENT_ID") {
    throw new Error("GITHUB_CLIENT_ID is not configured.");
  }
  if (!clientSecret) throw new Error("GITHUB_CLIENT_SECRET is not configured.");
  return { clientId, clientSecret };
}

function requireProviderConfig(env, pluginId) {
  const provider = PROVIDERS[pluginId];
  if (!provider) throw new Error(`OAuth is managed elsewhere for ${pluginId}.`);
  const clientId = env[provider.clientId]?.trim();
  const clientSecret = env[provider.clientSecret]?.trim();
  if (!clientId) throw new Error(`${provider.clientId} is not configured.`);
  if (!clientSecret) throw new Error(`${provider.clientSecret} is not configured.`);
  return { ...provider, clientId, clientSecret };
}

function isPluginId(value) {
  return typeof value === "string" && PLUGIN_IDS.includes(value);
}

function isLoopbackRedirect(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port.length > 0 &&
      url.pathname === "/github/oauth/callback" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function isPkceVerifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/u.test(value);
}

function isOpaqueToken(value) {
  return typeof value === "string" && value.length >= 20 && value.length <= 4096 && !/\s/u.test(value);
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error("Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error("Request body is too large.");
  }
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
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

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

function clerkIssuerFromPublishableKey(key) {
  if (typeof key !== "string" || !/^pk_(?:test|live)_/u.test(key)) return null;
  try {
    const encoded = key.split("_")[2];
    if (!encoded) return null;
    const domain = new TextDecoder().decode(base64UrlToBytes(encoded)).replace(/\$$/u, "");
    return domain ? `https://${domain}` : null;
  } catch {
    return null;
  }
}

async function getJwks(issuer) {
  const cached = jwksCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(`${issuer.replace(/\/$/u, "")}/.well-known/jwks.json`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Unable to load Clerk signing keys.");
  const value = await response.json();
  if (!value || !Array.isArray(value.keys)) throw new Error("Clerk JWKS response is invalid.");
  jwksCache.set(issuer, { value, expiresAt: Date.now() + 10 * 60_000 });
  return value;
}

async function verifyClerkJwt(token, env) {
  if (!isOpaqueToken(token)) throw new Error("Invalid Clerk session token.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Clerk session token.");
  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("Unsupported Clerk signing algorithm.");
  }
  const configuredIssuer = env.CLERK_ISSUER?.trim() || clerkIssuerFromPublishableKey(env.CLERK_PUBLISHABLE_KEY?.trim());
  if (!configuredIssuer) throw new Error("CLERK_PUBLISHABLE_KEY or CLERK_ISSUER is not configured.");
  if (payload.iss !== configuredIssuer && payload.iss !== `${configuredIssuer}/`) {
    throw new Error("Clerk token issuer does not match this Sparky deployment.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now - 30) throw new Error("Clerk token expired.");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new Error("Clerk token is not active yet.");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("Clerk token is missing a subject.");
  const jwks = await getJwks(configuredIssuer);
  const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (!jwk) throw new Error("Clerk signing key is unknown.");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlToBytes(parts[2]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signingInput);
  if (!valid) throw new Error("Clerk token signature is invalid.");
  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    sessionId: typeof payload.sid === "string" ? payload.sid : null,
  };
}

async function createPluginSession(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return fail("Clerk authentication is required.", 401, "unauthorized");
  const identity = await verifyClerkJwt(authorization.slice(7).trim(), env);
  const token = await sealStateless(
    {
      type: "plugin-session",
      userId: identity.userId,
      email: identity.email,
      sessionId: identity.sessionId,
      expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
    env,
  );
  return json({ sessionToken: token, user: { id: identity.userId, email: identity.email } });
}

async function authenticatePluginSession(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!isOpaqueToken(token)) return null;
  const value = await openStateless(token, env);
  if (
    !value ||
    value.type !== "plugin-session" ||
    typeof value.userId !== "string" ||
    typeof value.expiresAt !== "number" ||
    value.expiresAt <= Math.floor(Date.now() / 1000)
  ) return null;
  return {
    token,
    userId: value.userId,
    email: typeof value.email === "string" ? value.email : null,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
  };
}

async function restoreClerkSession(request, env) {
  const pluginSession = await authenticatePluginSession(request, env);
  if (!pluginSession || !pluginSession.sessionId) {
    return fail("Sparky session is missing or expired.", 401, "unauthorized");
  }
  const secretKey = env.CLERK_SECRET_KEY?.trim() || "";
  if (!secretKey) {
    return fail("Clerk session restore is not configured.", 503, "configuration_error");
  }
  const response = await fetch(
    `https://api.clerk.com/v1/sessions/${encodeURIComponent(pluginSession.sessionId)}/tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const value = await response.json().catch(() => null);
  if (!response.ok || typeof value?.jwt !== "string") {
    return fail("Clerk could not refresh the saved Sparky session.", 401, "unauthorized");
  }
  const identity = await verifyClerkJwt(value.jwt, env);
  if (identity.userId !== pluginSession.userId || identity.sessionId !== pluginSession.sessionId) {
    return fail("The saved Sparky session identity did not match.", 401, "unauthorized");
  }
  return json({
    token: value.jwt,
    sessionId: identity.sessionId,
    user: { id: identity.userId, email: identity.email },
  });
}

async function revokePluginSession(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return fail("Sparky session is missing or expired.", 401, "unauthorized");
  }
  const token = authorization.slice(7).trim();
  if (!isOpaqueToken(token)) {
    return fail("Sparky session is missing or expired.", 401, "unauthorized");
  }
  // Logout clears the persistent client token. Keep this path off KV so auth
  // remains available after the namespace's daily quota is exhausted.
  return json({ revoked: true });
}

async function encryptionKey(env) {
  const raw = requireEncryptionSecret(env);
  const bytes = base64UrlToBytes(raw);
  if (bytes.byteLength !== 32) {
    throw new Error("PLUGIN_TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealStateless(value, env) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `s1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function openStateless(token, env) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts[0] !== "s1") return null;
  try {
    const cleartext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(parts[1]) },
      await encryptionKey(env),
      base64UrlToBytes(parts[2]),
    );
    const value = JSON.parse(new TextDecoder().decode(cleartext));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

async function encryptRecord(value, env) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await encryptionKey(env);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({ version: 1, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)) });
}

async function decryptRecord(serialized, env) {
  const envelope = JSON.parse(serialized);
  if (envelope.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("Stored plugin credential is invalid.");
  }
  const key = await encryptionKey(env);
  const cleartext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv) },
    key,
    base64UrlToBytes(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(cleartext));
}

function connectionKey(userId, pluginId) {
  return `connection:${userId}:${pluginId}`;
}

async function saveConnection(env, userId, pluginId, token) {
  await requireStore(env).put(connectionKey(userId, pluginId), await encryptRecord(token, env));
}

async function loadConnection(env, userId, pluginId) {
  const stored = await requireStore(env).get(connectionKey(userId, pluginId));
  if (!stored) return null;
  try {
    return await decryptRecord(stored, env);
  } catch {
    // Leave malformed records for TTL/explicit cleanup. Deleting on every
    // status poll can exhaust the account's daily KV delete allowance.
    return null;
  }
}

async function deleteConnection(env, userId, pluginId) {
  await bestEffortDelete(requireStore(env), connectionKey(userId, pluginId));
}

function normalizeTokenPayload(value, existingRefreshToken = null) {
  const accessToken = value.access_token;
  if (typeof accessToken !== "string" || accessToken.length < 10) throw new Error("OAuth token endpoint did not return an access token.");
  const expiresIn = Number(value.expires_in);
  return {
    accessToken,
    refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : existingRefreshToken,
    tokenType: typeof value.token_type === "string" ? value.token_type : "Bearer",
    scope: typeof value.scope === "string" ? value.scope : "",
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    metadata: {},
  };
}

export function authorizationHeader(connection) {
  const tokenType = typeof connection?.tokenType === "string" ? connection.tokenType.trim() : "";
  // Slack's OAuth response describes bot/user tokens with token_type values
  // "bot"/"user", but its Web API still requires the HTTP Bearer scheme.
  const scheme = /^(?:bot|user)$/iu.test(tokenType) ? "Bearer" : tokenType || "Bearer";
  return `${scheme} ${connection?.accessToken ?? ""}`;
}

async function githubTokenRequest(env, fields) {
  const { clientId, clientSecret } = requireGitHubConfig(env);
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields });
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Sparky-Auth-Broker" },
    body,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || typeof value.access_token !== "string") {
    throw new Error(typeof value.error_description === "string" ? value.error_description : typeof value.error === "string" ? value.error : `GitHub token endpoint returned HTTP ${response.status}.`);
  }
  return {
    access_token: value.access_token,
    token_type: typeof value.token_type === "string" ? value.token_type : "bearer",
    expires_in: typeof value.expires_in === "number" ? value.expires_in : null,
    refresh_token: typeof value.refresh_token === "string" ? value.refresh_token : null,
    refresh_token_expires_in: typeof value.refresh_token_expires_in === "number" ? value.refresh_token_expires_in : null,
    scope: typeof value.scope === "string" ? value.scope : "",
  };
}

async function exchangeAuthorizationCode(request, env) {
  const body = await readJson(request);
  if (typeof body.code !== "string" || body.code.length < 8 || body.code.length > 2048) return fail("Invalid authorization code.");
  if (!isPkceVerifier(body.code_verifier)) return fail("Invalid PKCE verifier.");
  if (!isLoopbackRedirect(body.redirect_uri)) return fail("Invalid loopback redirect URI.");
  try {
    return json(await githubTokenRequest(env, { code: body.code, redirect_uri: body.redirect_uri, code_verifier: body.code_verifier }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "GitHub token exchange failed.", 502);
  }
}

async function refreshAccessToken(request, env) {
  const body = await readJson(request);
  if (!isOpaqueToken(body.refresh_token)) return fail("Invalid refresh token.");
  try {
    return json(await githubTokenRequest(env, { grant_type: "refresh_token", refresh_token: body.refresh_token }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "GitHub token refresh failed.", 502);
  }
}

async function revokeAuthorization(request, env) {
  const body = await readJson(request);
  if (!isOpaqueToken(body.access_token)) return fail("Invalid access token.");
  const { clientId, clientSecret } = requireGitHubConfig(env);
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(`${GITHUB_API}/applications/${encodeURIComponent(clientId)}/token`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "Sparky-Auth-Broker",
    },
    body: JSON.stringify({ access_token: body.access_token }),
  });
  if (response.status === 204 || response.status === 404) return new Response(null, { status: 204, headers: securityHeaders() });
  return fail(`GitHub revoke request returned HTTP ${response.status}.`, 502);
}

function workerBaseUrl(request, env) {
  if (env.PUBLIC_BASE_URL?.trim()) return env.PUBLIC_BASE_URL.trim().replace(/\/$/u, "");
  return new URL(request.url).origin;
}

function pluginCallbackUrl(request, env, pluginId) {
  return `${workerBaseUrl(request, env)}/v1/plugins/${pluginId}/callback`;
}

async function createPkce() {
  const verifier = randomToken(48);
  const challenge = await sha256(verifier);
  return { verifier, challenge };
}

async function startPluginAuthorization(request, env, session, pluginId) {
  if (pluginId === "github") {
    return json({ pluginId, status: "external", managedBy: "desktop-github", authorizationUrl: null });
  }
  const provider = requireProviderConfig(env, pluginId);
  const state = randomToken(32);
  const redirectUri = pluginCallbackUrl(request, env, pluginId);
  const pkce = provider.pkce ? await createPkce() : null;
  await requireStore(env).put(
    `oauth:${state}`,
    JSON.stringify({ userId: session.userId, pluginId, redirectUri, verifier: pkce?.verifier ?? null, createdAt: Date.now() }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );
  // Reset cancellation without spending a KV delete. The marker expires and
  // waitForAuthorization only treats the explicit "1" value as cancelled.
  await requireStore(env).put(`cancel:${session.userId}:${pluginId}`, "0", {
    expirationTtl: OAUTH_STATE_TTL_SECONDS,
  });
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (pluginId === "gmail") {
    url.searchParams.set("scope", provider.scopes.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  } else if (pluginId === "outlook") {
    url.searchParams.set("scope", provider.scopes.join(" "));
    url.searchParams.set("response_mode", "query");
  } else if (pluginId === "slack") {
    url.searchParams.set("scope", provider.scopes.join(","));
  } else if (pluginId === "jira") {
    url.searchParams.set("audience", "api.atlassian.com");
    url.searchParams.set("scope", provider.scopes.join(" "));
    url.searchParams.set("prompt", "consent");
  } else if (pluginId === "notion") {
    url.searchParams.set("owner", "user");
  } else if (pluginId === "sentry") {
    url.searchParams.set("scope", provider.scopes.join(" "));
  } else if (pluginId === "figma") {
    url.searchParams.set("scope", provider.scopes.join(","));
  }
  if (pkce) {
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return json({ pluginId, status: "pending", authorizationUrl: url.toString() });
}

async function exchangeProviderCode(env, pluginId, provider, code, redirectUri, verifier) {
  let response;
  if (pluginId === "notion") {
    response = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${provider.clientId}:${provider.clientSecret}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
  } else if (pluginId === "jira") {
    response = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
  } else {
    const fields = {
      grant_type: "authorization_code",
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: redirectUri,
    };
    if (verifier) fields.code_verifier = verifier;
    response = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok || (pluginId === "slack" && value.ok === false)) {
    throw new Error(typeof value.error_description === "string" ? value.error_description : typeof value.error === "string" ? value.error : `OAuth token exchange returned HTTP ${response.status}.`);
  }
  const token = normalizeTokenPayload(value);
  if (pluginId === "notion") {
    token.metadata = {
      workspaceId: typeof value.workspace_id === "string" ? value.workspace_id : null,
      workspaceName: typeof value.workspace_name === "string" ? value.workspace_name : null,
    };
  } else if (pluginId === "slack") {
    token.metadata = {
      teamId: typeof value.team?.id === "string" ? value.team.id : null,
      teamName: typeof value.team?.name === "string" ? value.team.name : null,
    };
  } else if (pluginId === "jira") {
    const resources = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
      headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
    }).then((result) => (result.ok ? result.json() : []));
    const resource = Array.isArray(resources) ? resources[0] : null;
    token.metadata = {
      cloudId: typeof resource?.id === "string" ? resource.id : null,
      siteName: typeof resource?.name === "string" ? resource.name : null,
      siteUrl: typeof resource?.url === "string" ? resource.url : null,
    };
  }
  return token;
}

function callbackHtml(pluginId, ok, message) {
  const payload = JSON.stringify({ source: "sparky-plugin-oauth", pluginId, ok, message });
  const title = ok ? "Connected to Sparky" : "Sparky authorization failed";
  const body = ok ? `${pluginId} is connected. You can close this window.` : message;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:460px;padding:32px;text-align:center"><h1 style="font-size:20px">${title}</h1><p style="opacity:.72">${body}</p></main><script>try{window.opener&&window.opener.postMessage(${payload},"*")}finally{setTimeout(()=>window.close(),450)}</script></body></html>`;
}

async function handlePluginCallback(request, env, pluginId) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) return new Response(callbackHtml(pluginId, false, "Missing OAuth code or state."), { status: 400, headers: { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8" } });
  const store = requireStore(env);
  const pending = await store.get(`oauth:${state}`, "json");
  await bestEffortDelete(store, `oauth:${state}`);
  if (!pending || pending.pluginId !== pluginId || typeof pending.userId !== "string") {
    return new Response(callbackHtml(pluginId, false, "This authorization request expired or is invalid."), { status: 400, headers: { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8" } });
  }
  try {
    const provider = requireProviderConfig(env, pluginId);
    const token = await exchangeProviderCode(env, pluginId, provider, code, pending.redirectUri, pending.verifier);
    await saveConnection(env, pending.userId, pluginId, token);
    return new Response(callbackHtml(pluginId, true, "Connected."), { headers: { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8" } });
  } catch (error) {
    return new Response(callbackHtml(pluginId, false, error instanceof Error ? error.message : "OAuth exchange failed."), { status: 502, headers: { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8" } });
  }
}

async function importGitHubConnection(request, env, session) {
  const body = await readJson(request);
  if (!isOpaqueToken(body.access_token)) return fail("Invalid GitHub access token.");
  const profile = await fetch(`${GITHUB_API}/user`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${body.access_token}`, "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "Sparky-Plugin-Broker" },
  });
  if (!profile.ok) return fail("GitHub rejected the existing Sparky authorization.", 401, "github_auth_invalid");
  const user = await profile.json().catch(() => ({}));
  await saveConnection(env, session.userId, "github", {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    tokenType: typeof body.token_type === "string" ? body.token_type : "bearer",
    expiresAt: typeof body.expires_at === "number" ? body.expires_at : null,
    scope: typeof body.scope === "string" ? body.scope : "",
    metadata: { login: typeof user.login === "string" ? user.login : null },
  });
  return json({ pluginId: "github", connected: true });
}

async function refreshProviderToken(env, pluginId, connection) {
  if (!connection.refreshToken) return connection;
  const provider = pluginId === "github" ? null : requireProviderConfig(env, pluginId);
  let response;
  if (pluginId === "github") {
    const value = await githubTokenRequest(env, { grant_type: "refresh_token", refresh_token: connection.refreshToken });
    return { ...connection, ...normalizeTokenPayload(value, connection.refreshToken), metadata: connection.metadata ?? {} };
  }
  if (pluginId === "notion") {
    response = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Basic ${btoa(`${provider.clientId}:${provider.clientSecret}`)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: connection.refreshToken }),
    });
  } else if (pluginId === "jira") {
    response = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: provider.clientId, client_secret: provider.clientSecret, refresh_token: connection.refreshToken }),
    });
  } else {
    response = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: provider.clientId, client_secret: provider.clientSecret, refresh_token: connection.refreshToken }),
    });
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok || (pluginId === "slack" && value.ok === false)) throw new Error(`Unable to refresh ${pluginId} authorization.`);
  return { ...connection, ...normalizeTokenPayload(value, connection.refreshToken), metadata: connection.metadata ?? {} };
}

async function activeConnection(env, userId, pluginId) {
  let connection = await loadConnection(env, userId, pluginId);
  if (!connection) return null;
  if (typeof connection.expiresAt === "number" && connection.expiresAt <= Date.now() + TOKEN_EXPIRY_SKEW_MS) {
    try {
      connection = await refreshProviderToken(env, pluginId, connection);
      await saveConnection(env, userId, pluginId, connection);
    } catch {
      if (connection.expiresAt <= Date.now()) {
        await deleteConnection(env, userId, pluginId);
        return null;
      }
    }
  }
  return connection;
}

async function listPluginStatus(env, session) {
  const plugins = [];
  for (const pluginId of PLUGIN_IDS) {
    const connection = await activeConnection(env, session.userId, pluginId);
    plugins.push({ pluginId, connected: connection !== null, metadata: connection?.metadata ?? null });
  }
  return plugins;
}

async function disconnectPlugin(env, session, pluginId) {
  const connection = await loadConnection(env, session.userId, pluginId);
  if (connection && pluginId === "github") {
    try {
      const { clientId, clientSecret } = requireGitHubConfig(env);
      await fetch(`${GITHUB_API}/applications/${encodeURIComponent(clientId)}/token`, {
        method: "DELETE",
        headers: { Accept: "application/vnd.github+json", Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, "Content-Type": "application/json", "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "Sparky-Plugin-Broker" },
        body: JSON.stringify({ access_token: connection.accessToken }),
      });
    } catch {
      // Local GitHub integration also revokes its credential; deletion here must still succeed.
    }
  }
  await deleteConnection(env, session.userId, pluginId);
  return json({ pluginId, connected: false });
}

async function cancelPluginAuthorization(env, session, pluginId) {
  await requireStore(env).put(`cancel:${session.userId}:${pluginId}`, "1", { expirationTtl: OAUTH_STATE_TTL_SECONDS });
  return json({ pluginId, status: "cancelled" });
}

function inputString(input, name, required = true) {
  const value = typeof input?.[name] === "string" ? input[name].trim() : "";
  if (required && !value) throw new Error(`${name} is required.`);
  return value;
}

function inputNumber(input, name, fallback, min = 1, max = 100) {
  const value = Number(input?.[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

async function apiJson(url, connection, init = {}, extraHeaders = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: authorizationHeader(connection),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
      ...(init.headers || {}),
    },
  });
  if (response.status === 204) return { ok: true };
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = { text: text.slice(0, 100_000) };
  }
  if (!response.ok) {
    const message = value?.message || value?.error?.message || value?.error || `${response.status} ${response.statusText}`;
    throw new Error(typeof message === "string" ? message : `Plugin API request failed with HTTP ${response.status}.`);
  }
  if (url.startsWith("https://slack.com/api/") && value?.ok === false) {
    const message = typeof value.error === "string" ? value.error : "Slack API returned an unsuccessful response.";
    throw new Error(`Slack API error: ${message}`);
  }
  return value;
}

function rfc822Raw(input) {
  const to = inputString(input, "to");
  const subject = inputString(input, "subject");
  const body = inputString(input, "body");
  const message = `To: ${to}\r\nSubject: ${subject.replace(/[\r\n]/gu, " ")}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  return bytesToBase64Url(new TextEncoder().encode(message));
}

async function executePluginAction(env, session, pluginId, action, input) {
  const connection = await activeConnection(env, session.userId, pluginId);
  if (!connection) throw new Error(`${pluginId} is not connected. Request authorization before using it.`);

  if (pluginId === "github") {
    const headers = { "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "Sparky-Plugin-Tool" };
    if (action === "list_repositories") return apiJson(`${GITHUB_API}/user/repos?sort=updated&per_page=${inputNumber(input, "limit", 30, 1, 100)}`, connection, {}, headers);
    const repo = encodeURIComponent(inputString(input, "repository")).replaceAll("%2F", "/");
    if (action === "list_pull_requests") return apiJson(`${GITHUB_API}/repos/${repo}/pulls?state=${encodeURIComponent(inputString(input, "state", false) || "open")}&per_page=${inputNumber(input, "limit", 30, 1, 100)}`, connection, {}, headers);
    if (action === "get_pull_request") return apiJson(`${GITHUB_API}/repos/${repo}/pulls/${inputNumber(input, "number", 1, 1, 1_000_000)}`, connection, {}, headers);
    if (action === "create_issue") return apiJson(`${GITHUB_API}/repos/${repo}/issues`, connection, { method: "POST", body: JSON.stringify({ title: inputString(input, "title"), body: inputString(input, "body", false) || undefined }) }, headers);
    if (action === "create_comment") return apiJson(`${GITHUB_API}/repos/${repo}/issues/${inputNumber(input, "number", 1, 1, 1_000_000)}/comments`, connection, { method: "POST", body: JSON.stringify({ body: inputString(input, "body") }) }, headers);
  }

  if (pluginId === "gmail") {
    const base = "https://gmail.googleapis.com/gmail/v1/users/me";
    if (action === "search_messages") return apiJson(`${base}/messages?q=${encodeURIComponent(inputString(input, "query", false))}&maxResults=${inputNumber(input, "limit", 25, 1, 100)}`, connection);
    if (action === "get_message") return apiJson(`${base}/messages/${encodeURIComponent(inputString(input, "messageId"))}?format=full`, connection);
    if (action === "send_email") return apiJson(`${base}/messages/send`, connection, { method: "POST", body: JSON.stringify({ raw: rfc822Raw(input) }) });
    if (action === "create_draft") return apiJson(`${base}/drafts`, connection, { method: "POST", body: JSON.stringify({ message: { raw: rfc822Raw(input) } }) });
  }

  if (pluginId === "outlook") {
    const base = "https://graph.microsoft.com/v1.0/me";
    if (action === "list_messages") {
      const query = inputString(input, "query", false);
      const suffix = query ? `&$search=${encodeURIComponent(`\"${query.replaceAll('"', '')}\"`)}` : "";
      return apiJson(`${base}/messages?$top=${inputNumber(input, "limit", 25, 1, 100)}&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview${suffix}`, connection, {}, query ? { ConsistencyLevel: "eventual" } : {});
    }
    if (action === "get_message") return apiJson(`${base}/messages/${encodeURIComponent(inputString(input, "messageId"))}`, connection);
    if (action === "send_email") return apiJson(`${base}/sendMail`, connection, { method: "POST", body: JSON.stringify({ message: { subject: inputString(input, "subject"), body: { contentType: "Text", content: inputString(input, "body") }, toRecipients: [{ emailAddress: { address: inputString(input, "to") } }] }, saveToSentItems: true }) });
    if (action === "create_draft") return apiJson(`${base}/messages`, connection, { method: "POST", body: JSON.stringify({ subject: inputString(input, "subject"), body: { contentType: "Text", content: inputString(input, "body") }, toRecipients: [{ emailAddress: { address: inputString(input, "to") } }] }) });
  }

  if (pluginId === "slack") {
    const base = "https://slack.com/api";
    if (action === "list_channels") return apiJson(`${base}/conversations.list?limit=${inputNumber(input, "limit", 100, 1, 200)}&types=public_channel,private_channel`, connection);
    if (action === "read_channel") return apiJson(`${base}/conversations.history?channel=${encodeURIComponent(inputString(input, "channel"))}&limit=${inputNumber(input, "limit", 50, 1, 100)}`, connection);
    if (action === "send_message") return apiJson(`${base}/chat.postMessage`, connection, { method: "POST", body: JSON.stringify({ channel: inputString(input, "channel"), text: inputString(input, "text") }) });
  }

  if (pluginId === "jira") {
    const cloudId = connection.metadata?.cloudId;
    if (typeof cloudId !== "string" || !cloudId) throw new Error("Jira connection does not have an accessible Cloud ID.");
    const base = `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`;
    if (action === "search_issues") return apiJson(`${base}/search/jql?jql=${encodeURIComponent(inputString(input, "jql"))}&maxResults=${inputNumber(input, "limit", 25, 1, 100)}`, connection);
    if (action === "get_issue") return apiJson(`${base}/issue/${encodeURIComponent(inputString(input, "issueKey"))}`, connection);
    if (action === "create_issue") {
      if (!input.fields || typeof input.fields !== "object" || Array.isArray(input.fields)) throw new Error("fields is required for Jira create_issue.");
      return apiJson(`${base}/issue`, connection, { method: "POST", body: JSON.stringify({ fields: input.fields }) });
    }
    if (action === "update_issue") {
      if (!input.fields || typeof input.fields !== "object" || Array.isArray(input.fields)) throw new Error("fields is required for Jira update_issue.");
      return apiJson(`${base}/issue/${encodeURIComponent(inputString(input, "issueKey"))}`, connection, { method: "PUT", body: JSON.stringify({ fields: input.fields }) });
    }
  }

  if (pluginId === "notion") {
    const headers = { "Notion-Version": "2025-09-03" };
    if (action === "search") return apiJson("https://api.notion.com/v1/search", connection, { method: "POST", body: JSON.stringify({ query: inputString(input, "query", false) || undefined, page_size: inputNumber(input, "limit", 25, 1, 100) }) }, headers);
    if (action === "get_page") return apiJson(`https://api.notion.com/v1/pages/${encodeURIComponent(inputString(input, "pageId"))}`, connection, {}, headers);
    if (action === "create_page") {
      if (!input.parent || !input.properties) throw new Error("parent and properties are required for Notion create_page.");
      return apiJson("https://api.notion.com/v1/pages", connection, { method: "POST", body: JSON.stringify({ parent: input.parent, properties: input.properties, ...(Array.isArray(input.children) ? { children: input.children } : {}) }) }, headers);
    }
    if (action === "update_page") {
      const pageId = inputString(input, "pageId");
      const body = {};
      for (const key of ["properties", "archived", "in_trash", "icon", "cover"]) if (input[key] !== undefined) body[key] = input[key];
      return apiJson(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, connection, { method: "PATCH", body: JSON.stringify(body) }, headers);
    }
  }

  if (pluginId === "sentry") {
    const base = "https://sentry.io/api/0";
    if (action === "list_issues") return apiJson(`${base}/organizations/${encodeURIComponent(inputString(input, "organizationSlug"))}/issues/?query=${encodeURIComponent(inputString(input, "query", false))}&limit=${inputNumber(input, "limit", 25, 1, 100)}`, connection);
    if (action === "get_issue") return apiJson(`${base}/issues/${encodeURIComponent(inputString(input, "issueId"))}/`, connection);
    if (action === "update_issue") return apiJson(`${base}/issues/${encodeURIComponent(inputString(input, "issueId"))}/`, connection, { method: "PUT", body: JSON.stringify(input.fields && typeof input.fields === "object" ? input.fields : { status: inputString(input, "status") }) });
  }

  if (pluginId === "figma") {
    const base = "https://api.figma.com/v1";
    const fileKey = encodeURIComponent(inputString(input, "fileKey"));
    if (action === "get_file") return apiJson(`${base}/files/${fileKey}`, connection);
    if (action === "get_comments") return apiJson(`${base}/files/${fileKey}/comments`, connection);
    if (action === "post_comment") return apiJson(`${base}/files/${fileKey}/comments`, connection, { method: "POST", body: JSON.stringify({ message: inputString(input, "message"), ...(input.clientMeta && typeof input.clientMeta === "object" ? { client_meta: input.clientMeta } : {}) }) });
  }

  throw new Error(`Unsupported ${pluginId} action '${action}'.`);
}

const ACTIONS = {
  github: ["list_repositories", "list_pull_requests", "get_pull_request", "create_issue", "create_comment"],
  jira: ["search_issues", "get_issue", "create_issue", "update_issue"],
  notion: ["search", "get_page", "create_page", "update_page"],
  gmail: ["search_messages", "get_message", "send_email", "create_draft"],
  outlook: ["list_messages", "get_message", "send_email", "create_draft"],
  slack: ["list_channels", "read_channel", "send_message"],
  sentry: ["list_issues", "get_issue", "update_issue"],
  figma: ["get_file", "get_comments", "post_comment"],
};

async function waitForAuthorization(env, session, pluginId) {
  const deadline = Date.now() + AUTH_WAIT_MS;
  while (Date.now() < deadline) {
    if (await activeConnection(env, session.userId, pluginId)) return { status: "connected", pluginId };
    if ((await requireStore(env).get(`cancel:${session.userId}:${pluginId}`)) === "1") return { status: "cancelled", pluginId };
    await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_MS));
  }
  return { status: "pending", pluginId, message: "Authorization is still pending. The user can finish it from the Sparky authorization card." };
}

async function handleMcp(request, env, session) {
  const message = await readJson(request);
  const id = message.id ?? null;
  const method = message.method;
  const ok = (result) => json({ jsonrpc: "2.0", id, result });
  const error = (code, messageText) => json({ jsonrpc: "2.0", id, error: { code, message: messageText } });
  if (method === "initialize") {
    return ok({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "sparky-plugins", version: "1.0.0" } });
  }
  if (method === "notifications/initialized") return new Response(null, { status: 202, headers: securityHeaders() });
  if (method === "tools/list") {
    const statuses = await listPluginStatus(env, session);
    const connected = statuses.filter((entry) => entry.connected).map((entry) => entry.pluginId);
    return ok({
      tools: [
        {
          name: "sparky_request_plugin_authorization",
          description: "Ask the user to authorize one of Sparky's supported plugins. Call this only when the user's prompt explicitly asks to use that plugin and it is not connected. This is a normal, non-fatal interaction if the user cancels.",
          inputSchema: { type: "object", additionalProperties: false, required: ["pluginId"], properties: { pluginId: { type: "string", enum: PLUGIN_IDS } } },
        },
        {
          name: "sparky_plugin_call",
          description: `Use a connected Sparky plugin. Connected now: ${connected.length ? connected.join(", ") : "none"}. Supported actions: ${Object.entries(ACTIONS).map(([pluginId, actions]) => `${pluginId}=[${actions.join(", ")}]`).join("; ")}. Plugin references in the prompt are optional and do not grant access.`,
          inputSchema: { type: "object", additionalProperties: false, required: ["pluginId", "action", "input"], properties: { pluginId: { type: "string", enum: PLUGIN_IDS }, action: { type: "string" }, input: { type: "object" } } },
        },
      ],
    });
  }
  if (method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    try {
      if (name === "sparky_request_plugin_authorization") {
        const pluginId = args.pluginId;
        if (!isPluginId(pluginId)) throw new Error("Unknown plugin.");
        await requireStore(env).put(`requested:${session.userId}:${pluginId}`, String(Date.now()), { expirationTtl: OAUTH_STATE_TTL_SECONDS });
        const result = await waitForAuthorization(env, session, pluginId);
        return ok({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
      }
      if (name === "sparky_plugin_call") {
        const pluginId = args.pluginId;
        if (!isPluginId(pluginId)) throw new Error("Unknown plugin.");
        if (!ACTIONS[pluginId].includes(args.action)) throw new Error(`Unsupported ${pluginId} action '${args.action}'.`);
        const result = await executePluginAction(env, session, pluginId, args.action, args.input && typeof args.input === "object" ? args.input : {});
        return ok({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
      }
      throw new Error("Unknown Sparky plugin tool.");
    } catch (cause) {
      const messageText = cause instanceof Error ? cause.message : "Plugin tool failed.";
      return ok({ content: [{ type: "text", text: messageText }], isError: true });
    }
  }
  if (method === "ping") return ok({});
  return error(-32601, "Method not found");
}

async function withPluginSession(request, env, handler) {
  const session = await authenticatePluginSession(request, env);
  if (!session) return fail("Plugin session is invalid or expired.", 401, "unauthorized");
  return handler(session);
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: securityHeaders() });

  if (request.method === "GET" && url.pathname === "/health") {
    const githubClientId = env.GITHUB_CLIENT_ID?.trim() || "";
    const providerClientSecretsConfigured = Object.fromEntries(
      Object.entries(PROVIDERS).map(([pluginId, provider]) => [
        pluginId,
        Boolean(env[provider.clientSecret]?.trim()),
      ]),
    );
    return json({
      ok: true,
      githubClientIdConfigured: githubClientId.length > 0,
      clerkConfigured: Boolean(env.CLERK_ISSUER?.trim() || env.CLERK_PUBLISHABLE_KEY?.trim()),
      pluginStoreConfigured: Boolean(env.PLUGIN_STORE),
      tokenEncryptionConfigured: Boolean(env.PLUGIN_TOKEN_ENCRYPTION_KEY?.trim()),
      providerClientSecretsConfigured,
      plugins: PLUGIN_IDS,
    });
  }

  if (request.method === "GET") {
    const callback = url.pathname.match(/^\/v1\/plugins\/([a-z]+)\/callback$/u);
    if (callback && isPluginId(callback[1]) && callback[1] !== "github") {
      return handlePluginCallback(request, env, callback[1]);
    }
    if (url.pathname === "/v1/plugins") {
      return withPluginSession(request, env, async (session) => json({ plugins: await listPluginStatus(env, session) }));
    }
  }

  if (request.method === "POST" && url.pathname === "/v1/session") {
    try {
      return await createPluginSession(request, env);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Unable to create plugin session.", 401, "unauthorized");
    }
  }

  if (request.method === "DELETE" && url.pathname === "/v1/session") {
    try {
      return await revokePluginSession(request, env);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Unable to revoke Sparky session.", 500, "internal_error");
    }
  }

  if (request.method === "POST" && url.pathname === "/v1/clerk/restore") {
    try {
      return await restoreClerkSession(request, env);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Unable to restore the Clerk session.", 401, "unauthorized");
    }
  }

  if (request.method === "POST" && url.pathname === "/v1/mcp") {
    return withPluginSession(request, env, (session) => handleMcp(request, env, session));
  }

  if (request.method === "POST") {
    const authorize = url.pathname.match(/^\/v1\/plugins\/([a-z]+)\/authorize$/u);
    if (authorize && isPluginId(authorize[1])) {
      return withPluginSession(request, env, (session) => startPluginAuthorization(request, env, session, authorize[1]));
    }
    const cancel = url.pathname.match(/^\/v1\/plugins\/([a-z]+)\/cancel$/u);
    if (cancel && isPluginId(cancel[1])) {
      return withPluginSession(request, env, (session) => cancelPluginAuthorization(env, session, cancel[1]));
    }
    if (url.pathname === "/v1/plugins/github/import") {
      return withPluginSession(request, env, (session) => importGitHubConnection(request, env, session));
    }
  }

  if (request.method === "DELETE") {
    const disconnect = url.pathname.match(/^\/v1\/plugins\/([a-z]+)$/u);
    if (disconnect && isPluginId(disconnect[1])) {
      return withPluginSession(request, env, (session) => disconnectPlugin(env, session, disconnect[1]));
    }
  }

  if (request.method !== "POST") return fail("Not found.", 404, "not_found");
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) return fail("Content-Type must be application/json.", 415);
  try {
    if (url.pathname === "/v1/github/exchange") return await exchangeAuthorizationCode(request, env);
    if (url.pathname === "/v1/github/refresh") return await refreshAccessToken(request, env);
    if (url.pathname === "/v1/github/revoke") return await revokeAuthorization(request, env);
    return fail("Not found.", 404, "not_found");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Request failed.", 400);
  }
}

export {
  clerkIssuerFromPublishableKey,
  isLoopbackRedirect,
  isPkceVerifier,
  isPluginId,
  PLUGIN_IDS,
  requireStore,
  sha256,
  randomToken,
  sealStateless,
  openStateless,
  verifyClerkJwt,
};

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
