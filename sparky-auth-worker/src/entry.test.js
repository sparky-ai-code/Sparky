import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedToolText,
  boundedValue,
  clerkDesktopHtml,
  decodeClerkFrontendApi,
  normalizeAnalytics,
} from "./entry.js";

function publishableKeyFor(domain) {
  return `pk_test_${Buffer.from(`${domain}$`, "utf8").toString("base64url")}`;
}

test("decodes the Clerk frontend API from a publishable key", () => {
  const key = publishableKeyFor("clerk.sparky.example");
  assert.equal(decodeClerkFrontendApi(key), "clerk.sparky.example");
  assert.equal(decodeClerkFrontendApi("not-a-clerk-key"), null);
});

test("isolated Clerk page contains only the public key and frame protocol", () => {
  const key = publishableKeyFor("clerk.sparky.example");
  const html = clerkDesktopHtml({ CLERK_PUBLISHABLE_KEY: key });
  assert.ok(html);
  assert.match(html, /sparky-clerk-frame/u);
  assert.match(html, /clerk\.browser\.js/u);
  assert.match(html, /oauthFlow:\s*externalMode\s*\?\s*"redirect"\s*:\s*"popup"/u);
  assert.match(html, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(html, /secret[_-]?key/iu);
});

test("external Clerk page uses a browser-owned redirect and one-time app handoff", () => {
  const key = publishableKeyFor("clerk.sparky.example");
  const url = new URL(
    "https://auth.sparky.llc/v1/clerk/desktop?mode=external&redirect_uri=sparky%3A%2F%2Fapp%2Fclerk-callback&state=state_1234567890123456",
  );
  const html = clerkDesktopHtml({ CLERK_PUBLISHABLE_KEY: key }, url);
  assert.match(html, /oauthFlow:\s*externalMode\s*\?\s*"redirect"\s*:\s*"popup"/u);
  assert.match(html, /forceRedirectUrl/u);
  assert.match(html, /v1\/clerk\/bridge/u);
  assert.match(html, /sparky:\/\/app\/clerk-callback/u);
});

test("bounds large tool payloads before returning them to model context", () => {
  const shaped = boundedValue({
    message: "x".repeat(20_000),
    items: Array.from({ length: 100 }, (_, index) => index),
  });
  assert.equal(typeof shaped, "object");
  assert.ok(shaped.message.length < 20_000);
  assert.ok(shaped.items.length < 100);

  const text = boundedToolText(JSON.stringify({ payload: "x".repeat(80_000) }));
  assert.ok(text.length < 45_000);
  assert.match(text, /truncated/u);
});

test("upgrades legacy analytics rows with the new counters", () => {
  const analytics = normalizeAnalytics(
    {
      userId: "old-user",
      prompts: 2,
      modelCalls: 3,
      models: { "gpt-test": 3 },
    },
    "user_123",
  );
  assert.equal(analytics.userId, "user_123");
  assert.equal(analytics.prompts, 2);
  assert.equal(analytics.modelCalls, 3);
  assert.equal(analytics.modelRequests, 0);
  assert.equal(analytics.agentCalls, 0);
  assert.equal(analytics.pluginAuthorizations, 0);
  assert.equal(analytics.pluginUses, 0);
  assert.deepEqual(analytics.models, { "gpt-test": 3 });
});
