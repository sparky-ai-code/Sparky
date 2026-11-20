/**
 * Pure helpers that build the Claude Agent SDK `query()` options for a Sparky
 * Claude Code session.
 *
 * Two auth modes, both without Sparky ever touching a credential:
 *   - `claudeAccount` (default): the user's own unmodified Claude Code is already
 *     signed in with `claude auth login`, which runs Anthropic's own sign-in flow.
 *     Sparky runs that binary and never reads, stores or forwards the tokens.
 *   - `apiKey`: a Claude Console API key from Sparky's Models settings.
 *   The child environment is an explicit allow-list. Token variables are always
 *   removed, and in `claudeAccount` mode no API key is passed, so the CLI uses its
 *   own stored sign-in. User settings are not loaded, since they can define an
 *   apiKeyHelper or other login path.
 *   The session's `apiKeySource` is verified at runtime; see
 *   `isAcceptedClaudeAgentApiKeySource`.
 *
 *   Caveat: Anthropic's Agent SDK docs direct developers to API-key authentication
 *   and say third-party products may not offer claude.ai login. Confirm this mode
 *   with Anthropic before shipping it to users.
 *
 * @module claudeAgent/ClaudeAgentOptions
 */
import type { Options, McpHttpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export const SPARKY_MCP_SERVER_NAME = "sparky";

/** Variables that carry a subscription or OAuth identity. Always removed. */
const SUBSCRIPTION_CREDENTIAL_ENV_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_API_KEY_HELPER",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/** Environment variables a Claude Code child process genuinely needs. */
const CHILD_ENV_ALLOW_LIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  // Where the user's own Claude Code keeps its sign-in. A path, not a credential.
  "CLAUDE_CONFIG_DIR",
] as const;

export type ClaudeAgentAuthMode = "claudeAccount" | "apiKey";

export interface ClaudeAgentCredentialResolution {
  readonly ok: true;
  readonly apiKey: string;
}

export interface ClaudeAgentCredentialFailure {
  readonly ok: false;
  readonly reason: string;
}

/**
 * Resolve the only credential Sparky's Claude Code runtime may use: an
 * Anthropic Console API key supplied through the Models settings environment.
 */
export function resolveClaudeAgentApiKey(
  environment: NodeJS.ProcessEnv,
): ClaudeAgentCredentialResolution | ClaudeAgentCredentialFailure {
  const apiKey = environment.ANTHROPIC_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) {
    return {
      ok: false,
      reason:
        "Claude Code needs an Anthropic API key. Add ANTHROPIC_API_KEY in Models settings. Sparky does not use Claude subscription logins.",
    };
  }
  return { ok: true, apiKey };
}

/**
 * Build the child-process environment. Only allow-listed variables pass through,
 * subscription credentials are removed, and ANTHROPIC_API_KEY is set explicitly.
 */
export function buildClaudeAgentChildEnvironment(input: {
  readonly environment: NodeJS.ProcessEnv;
  /** Set only in `apiKey` mode. In `claudeAccount` mode the CLI uses its own sign-in. */
  readonly apiKey?: string | undefined;
  readonly extra?: Readonly<Record<string, string>> | undefined;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOW_LIST) {
    const value = input.environment[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  for (const name of SUBSCRIPTION_CREDENTIAL_ENV_VARS) {
    delete env[name];
  }
  if (input.apiKey !== undefined) env.ANTHROPIC_API_KEY = input.apiKey;
  if (input.extra) {
    for (const [name, value] of Object.entries(input.extra)) {
      if (!SUBSCRIPTION_CREDENTIAL_ENV_VARS.includes(name as never)) env[name] = value;
    }
  }
  return env;
}

/**
 * The SDK reports where the credential for API requests came from. Only an
 * explicit Console API key is accepted. Anything else (OAuth login, a helper
 * command, or no key) means the session would run on a personal login, so the
 * adapter must stop the session.
 */
export function isAcceptedClaudeAgentApiKeySource(
  apiKeySource: string | undefined,
  authMode: ClaudeAgentAuthMode = "apiKey",
): boolean {
  // In claudeAccount mode, "none" means the CLI is signed in with the user's own
  // account (no key is passed). Helper commands and other login paths are refused.
  return authMode === "claudeAccount"
    ? apiKeySource === "none"
    : apiKeySource === "ANTHROPIC_API_KEY";
}

export interface BuildClaudeAgentOptionsInput {
  readonly cwd: string;
  readonly model: string | undefined;
  /** Console API key, passed only in `apiKey` mode. */
  readonly apiKey: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  /** Sparky MCP endpoint (the `/mcp` route) and its per-session bearer header. */
  readonly sparkyMcp?:
    | { readonly endpoint: string; readonly authorizationHeader: string }
    | undefined;
  readonly systemPromptAppend: string;
  /** `plan` makes Claude Code research and propose a plan before editing. */
  readonly permissionMode: "default" | "plan";
  /** Reasoning effort from the model selection, when Sparky has one. */
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  readonly resumeSessionId: string | undefined;
  readonly abortController: AbortController;
  readonly canUseTool: NonNullable<Options["canUseTool"]>;
  readonly maxThinkingTokens?: number | undefined;
  readonly pathToClaudeCodeExecutable?: string | undefined;
}

/** Tool names that Sparky exposes through its MCP bridge, as Claude Code names them. */
export const sparkyMcpToolPattern = `mcp__${SPARKY_MCP_SERVER_NAME}__*`;

export function buildClaudeAgentOptions(input: BuildClaudeAgentOptionsInput): Options {
  const mcpServers: Record<string, McpHttpServerConfig> = {};
  if (input.sparkyMcp) {
    mcpServers[SPARKY_MCP_SERVER_NAME] = {
      type: "http",
      url: input.sparkyMcp.endpoint,
      headers: { Authorization: input.sparkyMcp.authorizationHeader },
    };
  }
  return {
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    env: buildClaudeAgentChildEnvironment({ environment: input.environment, apiKey: input.apiKey }),
    // No user, project or local settings: they can define apiKeyHelper or other login paths.
    settingSources: [],
    systemPrompt: { type: "preset", preset: "claude_code", append: input.systemPromptAppend },
    mcpServers,
    // Sparky's own tools are pre-approved; built-in tools still go through canUseTool.
    allowedTools: input.sparkyMcp ? [sparkyMcpToolPattern] : [],
    permissionMode: input.permissionMode,
    includePartialMessages: true,
    canUseTool: input.canUseTool,
    abortController: input.abortController,
    ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.maxThinkingTokens !== undefined
      ? { maxThinkingTokens: input.maxThinkingTokens }
      : {}),
    ...(input.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable }
      : {}),
  };
}
