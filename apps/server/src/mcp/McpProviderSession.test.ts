import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@sparky/contracts";

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
