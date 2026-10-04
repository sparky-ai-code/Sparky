import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizationHeader,
  handleRequest,
  isLoopbackRedirect,
  isPkceVerifier,
  isPluginId,
  PLUGIN_IDS,
} from "./index.js";

const env = {
  GITHUB_CLIENT_ID: "Iv1.testclient",
  GITHUB_CLIENT_SECRET: "test-secret",
};

test("only accepts the exact loopback callback shape", () => {
  assert.equal(isLoopbackRedirect("http://127.0.0.1:48123/github/oauth/callback"), true);
  assert.equal(isLoopbackRedirect("http://localhost:48123/github/oauth/callback"), false);
  assert.equal(isLoopbackRedirect("https://127.0.0.1:48123/github/oauth/callback"), false);
  assert.equal(isLoopbackRedirect("http://127.0.0.1:48123/other"), false);
});

test("validates PKCE verifier length and character set", () => {
  assert.equal(isPkceVerifier("a".repeat(43)), true);
  assert.equal(isPkceVerifier("a".repeat(128)), true);
  assert.equal(isPkceVerifier("a".repeat(42)), false);
  assert.equal(isPkceVerifier("a".repeat(129)), false);
  assert.equal(isPkceVerifier("a".repeat(42) + "!"), false);
});

test("uses the Bearer HTTP scheme for Slack bot and user tokens", () => {
  assert.equal(authorizationHeader({ tokenType: "bot", accessToken: "xoxb-test" }), "Bearer xoxb-test");
  assert.equal(authorizationHeader({ tokenType: "user", accessToken: "xoxp-test" }), "Bearer xoxp-test");
  assert.equal(authorizationHeader({ tokenType: "bearer", accessToken: "provider-token" }), "bearer provider-token");
});

test("plugin catalog is the supported eight services", () => {
  assert.deepEqual(PLUGIN_IDS, [
    "github",
    "jira",
    "notion",
    "gmail",
    "outlook",
    "slack",
    "sentry",
    "figma",
  ]);
  for (const pluginId of PLUGIN_IDS) assert.equal(isPluginId(pluginId), true);
  assert.equal(isPluginId("discord"), false);
  assert.equal(isPluginId("googlecalendar"), false);
});

test("health endpoint reports configured state without leaking secret", async () => {
  const response = await handleRequest(new Request("https://auth.example/health"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    githubClientIdConfigured: true,
    clerkConfigured: false,
    pluginStoreConfigured: false,
    tokenEncryptionConfigured: false,
    providerClientSecretsConfigured: {
      gmail: false,
      outlook: false,
      slack: false,
      jira: false,
      notion: false,
      sentry: false,
      figma: false,
    },
    plugins: PLUGIN_IDS,
  });
  assert.equal(JSON.stringify(body).includes(env.GITHUB_CLIENT_SECRET), false);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
});

test("creates stable anonymous plugin sessions without Clerk authentication", async () => {
  const installationId = "d9428888-122b-4f71-9479-2f4f4f320f34";
  const anonymousEnv = {
    ...env,
    PLUGIN_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
  };
  const createSession = () =>
    handleRequest(
      new Request("https://auth.example/v1/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId }),
      }),
      anonymousEnv,
    );

  const firstResponse = await createSession();
  const secondResponse = await createSession();
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  const first = await firstResponse.json();
  const second = await secondResponse.json();
  assert.equal(first.anonymous, true);
  assert.equal(first.user.id, second.user.id);
  assert.equal(first.user.email, null);
  assert.notEqual(first.sessionToken, second.sessionToken);
});

test("rejects anonymous plugin sessions without a valid installation ID", async () => {
  const response = await handleRequest(
    new Request("https://auth.example/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationId: "not-a-uuid" }),
    }),
    env,
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /installation ID/i);
});

test("accepts explicit logout without accessing the plugin store", async () => {
  const token = "session-token-with-enough-length";
  const store = {
    async get() {
      throw new Error("Logout must not read the plugin store.");
    },
    async delete() {
      throw new Error("Logout must not write to the plugin store.");
    },
    async put() {
      throw new Error("Logout must not write to the plugin store.");
    },
  };
  const response = await handleRequest(
    new Request("https://auth.example/v1/session", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
    { ...env, PLUGIN_STORE: store },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: true });
});

test("rejects non-JSON token requests", async () => {
  const response = await handleRequest(
    new Request("https://auth.example/v1/github/exchange", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "nope",
    }),
    env,
  );
  assert.equal(response.status, 415);
});

test("rejects invalid callback before contacting GitHub", async () => {
  const response = await handleRequest(
    new Request("https://auth.example/v1/github/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "12345678",
        code_verifier: "a".repeat(43),
        redirect_uri: "https://attacker.example/callback",
      }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /loopback/i);
});
