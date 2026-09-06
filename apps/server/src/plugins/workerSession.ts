// @effect-diagnostics cryptoRandomUUIDInEffect:off globalDateInEffect:off globalFetchInEffect:off preferSchemaOverJson:off
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const DEFAULT_PLUGIN_WORKER_URL = "https://auth.sparky.llc";
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,4096}$/u;

let pluginSessionToken: string | null = null;

export const SUPPORTED_PLUGIN_IDS = [
  "github",
  "jira",
  "notion",
  "gmail",
  "outlook",
  "slack",
  "sentry",
  "figma",
] as const;

export type SupportedPluginId = (typeof SUPPORTED_PLUGIN_IDS)[number];

export class PluginWorkerUnavailableError extends Data.TaggedError("PluginWorkerUnavailableError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export function isSupportedPluginId(value: string): value is SupportedPluginId {
  return (SUPPORTED_PLUGIN_IDS as readonly string[]).includes(value);
}

export function setPluginSessionToken(value: string | null): void {
  const token = value?.trim() ?? "";
  pluginSessionToken = token && SESSION_TOKEN_PATTERN.test(token) ? token : null;
}

export function hasPluginSessionToken(): boolean {
  return pluginSessionToken !== null;
}

function workerBaseUrl(): string {
  const configured = process.env.SPARKY_PLUGIN_WORKER_URL?.trim() || DEFAULT_PLUGIN_WORKER_URL;
  try {
    const url = new URL(configured);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      )
    ) {
      return DEFAULT_PLUGIN_WORKER_URL;
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    return DEFAULT_PLUGIN_WORKER_URL;
  }
}

type WorkerMcpResult = {
  readonly content?: ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
};

export function callPluginWorkerTool(
  name: "sparky_request_plugin_authorization" | "sparky_plugin_call",
  args: Record<string, unknown>,
) {
  return Effect.tryPromise({
    try: async () => {
      const token = pluginSessionToken;
      if (!token) {
        throw new Error("Sparky plugins are unavailable until the signed-in account session is ready.");
      }
      const response = await fetch(`${workerBaseUrl()}/v1/mcp`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const envelope = (await response.json().catch(() => ({}))) as {
        readonly result?: WorkerMcpResult;
        readonly error?: { readonly message?: unknown };
      };
      if (!response.ok || envelope.error) {
        const detail =
          typeof envelope.error?.message === "string"
            ? envelope.error.message
            : `Plugin worker returned HTTP ${response.status}.`;
        throw new Error(detail);
      }
      const result = envelope.result;
      if (!result) throw new Error("Plugin worker returned an empty tool result.");
      const text = result.content?.find((item) => item.type === "text")?.text;
      if (result.isError) {
        throw new Error(typeof text === "string" ? text : "Plugin tool failed.");
      }
      if (result.structuredContent !== undefined) return result.structuredContent;
      if (typeof text !== "string") return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    },
    catch: (cause) =>
      new PluginWorkerUnavailableError({
        detail: cause instanceof Error ? cause.message : "Plugin worker request failed.",
        cause,
      }),
  });
}
