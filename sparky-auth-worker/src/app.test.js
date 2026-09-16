import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanDimension,
  emptyAnalytics,
  handleWrappedRequest,
  normalizeFigmaToken,
} from "./app.js";

function makeKv() {
  const values = new Map();
  return {
    async get(key, mode) {
      const value = values.get(key) ?? null;
      if (mode === "json" && typeof value === "string") return JSON.parse(value);
      return value;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

test("analytics records contain counters but no conversation fields", () => {
  const record = emptyAnalytics("user_123", "2026-09-03T00:00:00.000Z");
  assert.deepEqual(record, {
    userId: "user_123",
    signedUpAt: "2026-09-03T00:00:00.000Z",
    lastSeenAt: "2026-09-03T00:00:00.000Z",
    prompts: 0,
    modelCalls: 0,
    models: {},
    providers: {},
  });
  assert.equal("prompt" in record, false);
  assert.equal("content" in record, false);
});

test("analytics dimensions are bounded and stripped of unsafe characters", () => {
  assert.equal(cleanDimension("  gpt-5.6/luna  "), "gpt-5.6/luna");
  assert.equal(cleanDimension("provider<script>"), "providerscript");
  assert.equal(cleanDimension(""), null);
  assert.equal(cleanDimension(null), null);
  assert.ok(cleanDimension("x".repeat(200)).length <= 120);
});

test("Figma refresh responses keep the existing refresh token", () => {
  const token = normalizeFigmaToken(
    { access_token: "figma-access-token", token_type: "bearer", expires_in: 3600 },
    "figma-refresh-token",
    { userId: "123" },
  );
  assert.equal(token.accessToken, "figma-access-token");
  assert.equal(token.refreshToken, "figma-refresh-token");
  assert.equal(token.metadata.userId, "123");
  assert.ok(token.expiresAt > Date.now());
});

test("admin analytics endpoint requires its dedicated bearer secret", async () => {
  const env = { PLUGIN_STORE: makeKv(), ANALYTICS_ADMIN_TOKEN: "admin-secret" };
  const denied = await handleWrappedRequest(
    new Request("https://auth.example/v1/admin/analytics"),
    env,
  );
  assert.equal(denied.status, 401);

  const allowed = await handleWrappedRequest(
    new Request("https://auth.example/v1/admin/analytics", {
      headers: { Authorization: "Bearer admin-secret" },
    }),
    env,
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), {
    totals: { users: 0, prompts: 0, modelCalls: 0 },
    users: [],
  });
});

test("OAuth callback keeps the provider token-exchange error visible", async () => {
  const store = makeKv();
  await store.put(
    "oauth:test-outlook-state",
    JSON.stringify({
      userId: "user_test",
      pluginId: "outlook",
      redirectUri: "https://auth.example/v1/plugins/outlook/callback",
      verifier: "verifier_test",
    }),
  );
  const env = {
    PLUGIN_STORE: store,
    OUTLOOK_CLIENT_ID: "client-id",
    OUTLOOK_CLIENT_SECRET: "client-secret",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { error: "invalid_client", error_description: "The client secret is invalid." },
      { status: 401 },
    );
  try {
    const response = await handleWrappedRequest(
      new Request(
        "https://auth.example/v1/plugins/outlook/callback?code=code-12345678&state=test-outlook-state",
      ),
      env,
    );
    assert.equal(response.status, 502);
    assert.match(await response.text(), /The client secret is invalid/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
