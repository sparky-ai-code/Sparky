import assert from "node:assert/strict";
import test from "node:test";

import { restrictClerkFrameAncestors } from "./final.js";

test("Clerk desktop frame can only be embedded by Sparky renderer schemes", async () => {
  const response = restrictClerkFrameAncestors(
    new Response("ok", {
      headers: {
        "Content-Security-Policy":
          "default-src 'none'; script-src https:; frame-ancestors *; base-uri 'none'",
      },
    }),
  );
  const policy = response.headers.get("content-security-policy") ?? "";
  assert.match(policy, /frame-ancestors sparky:\/\/app sparky-dev:\/\/app/u);
  assert.doesNotMatch(policy, /frame-ancestors \*/u);
  assert.equal(await response.text(), "ok");
});
