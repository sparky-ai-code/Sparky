import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, ProviderInstanceId, ThreadId } from "@sparky/contracts";

import * as McpProviderSession from "./McpProviderSession.ts";

const threadId = ThreadId.make("thread-mcp-session-test");
const firstInstanceId = ProviderInstanceId.make("sparky-primary");
const secondInstanceId = ProviderInstanceId.make("sparky-secondary");

it("does not expose a thread credential to a different provider instance", () => {
  const config = {
    environmentId: EnvironmentId.make("environment-mcp-session-test"),
    threadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: firstInstanceId,
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer test-token",
  } satisfies McpProviderSession.McpProviderSessionConfig;

  McpProviderSession.setMcpProviderSession(config);
  try {
    expect(McpProviderSession.readMcpProviderSession(threadId, firstInstanceId)).toEqual(config);
    expect(McpProviderSession.readMcpProviderSession(threadId, secondInstanceId)).toBeUndefined();
  } finally {
    McpProviderSession.clearMcpProviderSession(threadId);
  }
});

it("isolates identical thread IDs by authenticated session", () => {
  const userA = AuthSessionId.make("auth-session-a");
  const userB = AuthSessionId.make("auth-session-b");
  const base = {
    environmentId: EnvironmentId.make("environment-mcp-session-isolation"),
    threadId,
    providerInstanceId: firstInstanceId,
    endpoint: "http://127.0.0.1:43123/mcp",
  } as const;
  const configA = {
    ...base,
    authSessionId: userA,
    providerSessionId: "provider-session-a",
    authorizationHeader: "Bearer user-a-token",
  } satisfies McpProviderSession.McpProviderSessionConfig;
  const configB = {
    ...base,
    authSessionId: userB,
    providerSessionId: "provider-session-b",
    authorizationHeader: "Bearer user-b-token",
  } satisfies McpProviderSession.McpProviderSessionConfig;

  McpProviderSession.setMcpProviderSession(configA);
  McpProviderSession.setMcpProviderSession(configB);
  try {
    expect(McpProviderSession.readMcpProviderSession(threadId, firstInstanceId, userA)).toEqual(
      configA,
    );
    expect(McpProviderSession.readMcpProviderSession(threadId, firstInstanceId, userB)).toEqual(
      configB,
    );
  } finally {
    McpProviderSession.clearMcpProviderSession(threadId, userA);
    McpProviderSession.clearMcpProviderSession(threadId, userB);
  }
});
