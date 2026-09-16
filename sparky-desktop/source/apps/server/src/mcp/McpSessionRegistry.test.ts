import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, ProviderInstanceId, ThreadId } from "@sparky/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderExecutionContext from "../provider/ProviderExecutionContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      idleTimeoutMs: 100,
      maximumLifetimeMs: 1_000,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect(
  "isolates plugin sessions by authenticated session and preserves User A on User B logout",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1_000);
      const userA = AuthSessionId.make("auth-session-a");
      const userB = AuthSessionId.make("auth-session-b");
      const tokenA = "user-a-plugin-session-token-123456";
      const tokenB = "user-b-plugin-session-token-123456";

      expect(yield* registry.setPluginSession(userA, tokenA)).toBe(true);
      expect(yield* registry.setPluginSession(userB, tokenB)).toBe(true);

      const issueFor = (authSessionId: AuthSessionId, threadId: string) =>
        registry
          .issue({
            threadId: ThreadId.make(threadId),
            providerInstanceId: ProviderInstanceId.make("sparky"),
          })
          .pipe(
            Effect.provideService(ProviderExecutionContext.ProviderExecutionContext, {
              authSessionId,
            }),
          );

      const issuedA = yield* issueFor(userA, "thread-a");
      const issuedB = yield* issueFor(userB, "thread-b");
      const mcpTokenB = issuedB.config.authorizationHeader.replace(/^Bearer\s+/u, "");
      expect(issuedA.config.pluginSessionToken).toBe(tokenA);
      expect(issuedB.config.pluginSessionToken).toBe(tokenB);

      expect(yield* registry.setPluginSession(userB, null)).toBe(false);
      expect(yield* registry.resolve(mcpTokenB)).toBeUndefined();
      const issuedAAfterUserBLogout = yield* issueFor(userA, "thread-a-2");
      expect(issuedAAfterUserBLogout.config.pluginSessionToken).toBe(tokenA);
    }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials after inactivity", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
