import type { AuthSessionId, EnvironmentId, ProviderInstanceId, ThreadId } from "@sparky/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly authSessionId?: AuthSessionId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly pluginSessionToken?: string;
}

const sessionsByKey = new Map<string, McpProviderSessionConfig>();

const sessionKey = (threadId: ThreadId, authSessionId?: AuthSessionId): string =>
  `${authSessionId ?? "anonymous"}:${threadId}`;

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByKey.set(sessionKey(config.threadId, config.authSessionId), config);
}

export function readMcpProviderSession(
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  authSessionId?: AuthSessionId,
): McpProviderSessionConfig | undefined {
  const config = sessionsByKey.get(sessionKey(threadId, authSessionId));
  return config?.providerInstanceId === providerInstanceId ? config : undefined;
}

export function clearMcpProviderSession(threadId: ThreadId, authSessionId?: AuthSessionId): void {
  if (authSessionId) {
    sessionsByKey.delete(sessionKey(threadId, authSessionId));
    return;
  }
  for (const key of sessionsByKey.keys()) {
    if (key.endsWith(`:${threadId}`)) sessionsByKey.delete(key);
  }
}

export function clearMcpProviderSessionsForAuthSession(authSessionId: AuthSessionId): void {
  for (const [key, config] of sessionsByKey) {
    if (config.authSessionId === authSessionId) sessionsByKey.delete(key);
  }
}

export function clearAllMcpProviderSessions(): void {
  sessionsByKey.clear();
}
