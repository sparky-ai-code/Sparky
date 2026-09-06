import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@sparky/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
): McpProviderSessionConfig | undefined {
  const config = sessionsByThread.get(threadId);
  return config?.providerInstanceId === providerInstanceId ? config : undefined;
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
