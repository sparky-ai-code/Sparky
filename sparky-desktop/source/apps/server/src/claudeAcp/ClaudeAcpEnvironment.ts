/**
 * Environment for the Claude ACP adapter process.
 *
 * Sparky does not read, store, or forward any Claude credential. The adapter runs
 * the unmodified Claude Code, which reads its own sign-in or the API key it is
 * given. Two sources feed the child environment:
 *   - An allow-list of ambient variables from Sparky's process (PATH, HOME, proxy
 *     settings, and so on). Sparky's own secrets, such as Models keys, are not
 *     included.
 *   - The variables the user sets on the Claude Code provider instance. These are
 *     explicit user configuration, the same as T3 Code's "Environment variables".
 *     That is where a user sets CLAUDE_CONFIG_DIR, CLAUDE_CODE_EXECUTABLE, or an
 *     ANTHROPIC_API_KEY if they want API billing.
 *
 * @module claudeAcp/ClaudeAcpEnvironment
 */

/** Ambient variables a Claude Code child genuinely needs from the host. */
const AMBIENT_ALLOW_LIST = [
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
] as const;

export function buildClaudeAcpEnvironment(input: {
  readonly ambient: NodeJS.ProcessEnv;
  /** Variables the user configured on the provider instance. */
  readonly instanceOverrides?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of AMBIENT_ALLOW_LIST) {
    const value = input.ambient[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  for (const override of input.instanceOverrides ?? []) {
    if (override.name.length > 0) env[override.name] = override.value;
  }
  return env;
}
