// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import type { ServerProviderModel } from "@sparky/contracts";
import { createModelCapabilities } from "@sparky/shared/model";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  isCodexOAuthModel,
  normalizeCodexOAuthEffectiveContextWindowTokens,
  readCodexOAuthContextWindow,
} from "../codexContextWindow.ts";

type FetchImplementation = typeof globalThis.fetch;

type ProviderDefinition = {
  readonly env?: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY";
  readonly prefix: "openai-codex" | "openai" | "anthropic" | "google";
  readonly label: "OpenAI Codex" | "OpenAI" | "Claude" | "Google";
  readonly load: (
    apiKey: string,
    fetchImplementation: FetchImplementation,
    environment: NodeJS.ProcessEnv,
    modelsDev?: ModelsDevCatalog,
  ) => Promise<ReadonlyArray<RemoteModel>>;
};

export function hasCodexOAuthAuthentication(environment: NodeJS.ProcessEnv): boolean {
  const environmentHome = environment.USERPROFILE?.trim() || environment.HOME?.trim();
  const authDirectory =
    environment.SPARKY_CODEX_HOME?.trim() ||
    environment.CODEX_HOME?.trim() ||
    (environmentHome ? NodePath.join(environmentHome, ".codex") : undefined);
  if (!authDirectory) return false;
  try {
    const credentials: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(authDirectory, "auth.json"), "utf8"),
    );
    return (
      isRecord(credentials) &&
      credentials.auth_mode === "chatgpt" &&
      isRecord(credentials.tokens) &&
      Boolean(nonEmptyString(credentials.tokens.access_token)) &&
      Boolean(nonEmptyString(credentials.tokens.refresh_token)) &&
      Boolean(nonEmptyString(credentials.tokens.account_id))
    );
  } catch {
    return false;
  }
}

type RemoteReasoningEffort = {
  readonly id: string;
  readonly label?: string;
};

type RemoteContextWindow = {
  readonly id: string;
  readonly tokens: number;
  readonly label?: string;
};

type ContextWindowSource = "provider" | "oauth" | "models.dev";

export type RemoteModel = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly reasoningSupported?: boolean | undefined;
  readonly reasoningEfforts?: ReadonlyArray<RemoteReasoningEffort>;
  readonly defaultReasoningEffort?: string | undefined;
  readonly contextWindows?: ReadonlyArray<RemoteContextWindow>;
  readonly defaultContextWindowTokens?: number | undefined;
  readonly contextWindowSource?: ContextWindowSource | undefined;
};

export type SparkyModelDiscovery = {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly configuredProviderCount: number;
  readonly errors: ReadonlyArray<string>;
};

type ModelsDevCatalog = Readonly<Record<string, Readonly<Record<string, Record<string, unknown>>>>>;

const REQUEST_TIMEOUT_MS = 12_000;

// Some installed Codex app-server builds lag the current ChatGPT entitlement
// catalog during staged model rollouts. Keep this OAuth-only fallback aligned
// with the official model id so an eligible account can select Astra while the
// local app-server catches up. Runtime authorization still remains provider-
// authoritative; an ineligible account receives the provider error.
const CODEX_OAUTH_KNOWN_MODELS: ReadonlyArray<RemoteModel> = [
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    reasoningSupported: true,
    reasoningEfforts: [
      { id: "low" },
      { id: "medium" },
      { id: "high" },
      { id: "xhigh" },
      { id: "max" },
    ],
    defaultReasoningEffort: "medium",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function humanizeModelId(modelId: string): string {
  return modelId
    .replace(/^models\//u, "")
    .split(/[-_/]+/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "ai") return "AI";
      if (lower === "tts") return "TTS";
      if (/^o\d+$/u.test(lower)) return lower;
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function parseReasoningEfforts(value: unknown): ReadonlyArray<RemoteReasoningEffort> {
  if (Array.isArray(value)) {
    const typedEntries = value.filter(
      (entry) => !isRecord(entry) || entry.type === undefined || entry.type === "effort",
    );
    return parseReasoningEffortEntries(
      typedEntries.flatMap((entry) =>
        isRecord(entry) && Array.isArray(entry.values) ? entry.values : [entry],
      ),
    );
  }
  if (!isRecord(value)) return [];

  const options = value.reasoning_options ?? value.reasoningOptions;
  if (options !== undefined) return parseReasoningEfforts(options);
  if (value.type === "effort" && Array.isArray(value.values)) {
    return parseReasoningEffortEntries(value.values);
  }

  const entries =
    value.levels ??
    value.options ??
    value.values ??
    value.efforts ??
    value.supportedEfforts ??
    value.supported_efforts;
  if (Array.isArray(entries)) return parseReasoningEffortEntries(entries);

  const namedLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  return parseReasoningEffortEntries(
    namedLevels.flatMap((id) => {
      const capability = value[id];
      return isRecord(capability) && capability.supported === true
        ? [{ id }]
        : capability === true
          ? [{ id }]
          : [];
    }),
  );
}

function parseReasoningEffortEntries(
  entries: ReadonlyArray<unknown>,
): ReadonlyArray<RemoteReasoningEffort> {
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (typeof entry === "string") {
      const id = nonEmptyString(entry);
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [{ id }];
    }
    if (!isRecord(entry)) return [];
    const id =
      nonEmptyString(entry.reasoningEffort) ??
      nonEmptyString(entry.effort) ??
      nonEmptyString(entry.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const label = nonEmptyString(entry.label) ?? nonEmptyString(entry.name);
    return [{ id, ...(label ? { label } : {}) }];
  });
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function contextWindowTokens(value: unknown): number | undefined {
  const numeric = positiveInteger(value);
  if (numeric) return numeric;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase().replaceAll(",", "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)(?:\s*(tokens?|k|m|b))?$/u);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2] ?? "";
  const multiplier = unit.startsWith("b")
    ? 1_000_000_000
    : unit === "m"
      ? 1_000_000
      : unit === "k"
        ? 1_000
        : 1;
  const tokens = amount * multiplier;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function canonicalContextWindowId(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return String(tokens);
}

function humanizeContextWindow(tokens: number): string {
  return canonicalContextWindowId(tokens).replace(/m$/u, "M");
}

function parseContextWindowEntry(value: unknown): RemoteContextWindow | undefined {
  if (isRecord(value)) {
    const tokens =
      contextWindowTokens(value.tokens) ??
      contextWindowTokens(value.tokenLimit) ??
      contextWindowTokens(value.contextWindow) ??
      contextWindowTokens(value.context_window) ??
      contextWindowTokens(value.contextLength) ??
      contextWindowTokens(value.context_length) ??
      contextWindowTokens(value.maxTokens) ??
      contextWindowTokens(value.max_tokens) ??
      contextWindowTokens(value.value) ??
      contextWindowTokens(value.size);
    if (!tokens) return undefined;
    const label = nonEmptyString(value.label) ?? nonEmptyString(value.name);
    return {
      id: canonicalContextWindowId(tokens),
      tokens,
      ...(label ? { label } : {}),
    };
  }
  const tokens = contextWindowTokens(value);
  return tokens
    ? { id: canonicalContextWindowId(tokens), tokens, label: humanizeContextWindow(tokens) }
    : undefined;
}

function parseContextWindows(value: Record<string, unknown>): {
  readonly contextWindows: ReadonlyArray<RemoteContextWindow>;
  readonly defaultContextWindowTokens?: number;
} {
  const entries: unknown[] = [];
  const sources = [
    value,
    ...(isRecord(value.capabilities) ? [value.capabilities] : []),
    ...(isRecord(value.capabilities) && isRecord(value.capabilities.context)
      ? [value.capabilities.context]
      : []),
    ...(isRecord(value.limits) ? [value.limits] : []),
    ...(isRecord(value.limit) ? [value.limit] : []),
    ...(isRecord(value.metadata) ? [value.metadata] : []),
  ];
  for (const source of sources) {
    for (const key of [
      "contextWindows",
      "context_windows",
      "supportedContextWindows",
      "supported_context_windows",
    ]) {
      const candidate = source[key];
      if (Array.isArray(candidate)) entries.push(...candidate);
      else if (candidate !== undefined) entries.push(candidate);
    }

    for (const key of [
      "contextWindow",
      "context_window",
      "contextLength",
      "context_length",
      "contextLengthTokens",
      "context_length_tokens",
      "contextWindowSize",
      "context_window_size",
      "maxInputTokens",
      "max_input_tokens",
      "maxContextTokens",
      "max_context_tokens",
      "maxContextLength",
      "max_context_length",
      "maxInputLength",
      "max_input_length",
      "inputTokenLimit",
      "input_token_limit",
    ]) {
      if (source[key] !== undefined) entries.push(source[key]);
    }

    for (const key of ["limit", "limits"]) {
      const limits = source[key];
      if (isRecord(limits) && limits.context !== undefined) entries.push(limits.context);
    }
  }

  const seen = new Set<number>();
  const contextWindows = entries.flatMap((entry) => {
    const parsed = parseContextWindowEntry(entry);
    if (!parsed || seen.has(parsed.tokens)) return [];
    seen.add(parsed.tokens);
    return [parsed];
  });

  const defaultContextWindowTokens = sources
    .flatMap((source) =>
      [
        "defaultContextWindow",
        "default_context_window",
        "defaultContextWindowTokens",
        "default_context_window_tokens",
      ].map((key) => contextWindowTokens(source[key])),
    )
    .find((candidate): candidate is number => candidate !== undefined);

  return {
    contextWindows,
    ...(defaultContextWindowTokens ? { defaultContextWindowTokens } : {}),
  };
}

function remoteModelFromRecord(
  value: Record<string, unknown>,
  contextWindowSource: ContextWindowSource = "provider",
): RemoteModel | undefined {
  const id = nonEmptyString(value.id) ?? nonEmptyString(value.model);
  if (!id) return undefined;
  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
  const reasoning =
    (isRecord(value.reasoning) ? value.reasoning : undefined) ??
    (isRecord(value.reasoning_capability) ? value.reasoning_capability : undefined) ??
    (isRecord(value.reasoning_capabilities) ? value.reasoning_capabilities : undefined) ??
    (isRecord(capabilities?.reasoning) ? capabilities.reasoning : undefined) ??
    (isRecord(capabilities?.effort) ? capabilities.effort : undefined) ??
    (isRecord(capabilities?.thinking) ? capabilities.thinking : undefined) ??
    (value.reasoning === true || value.thinking === true ? { supported: true } : undefined) ??
    (capabilities?.reasoning === true || capabilities?.thinking === true
      ? { supported: true }
      : undefined);
  const reasoningEfforts = parseReasoningEfforts(
    value.supportedReasoningEfforts ??
      value.supported_reasoning_efforts ??
      value.reasoningEfforts ??
      value.reasoning_efforts ??
      value.supportedEfforts ??
      value.supported_efforts ??
      value.reasoning_options ??
      value.reasoningOptions ??
      reasoning,
  );
  const reasoningSupported = [
    typeof value.reasoning === "boolean" ? value.reasoning : undefined,
    typeof value.thinking === "boolean" ? value.thinking : undefined,
    isRecord(reasoning) && typeof reasoning.supported === "boolean"
      ? reasoning.supported
      : undefined,
    isRecord(capabilities?.effort) && typeof capabilities.effort.supported === "boolean"
      ? capabilities.effort.supported
      : undefined,
    reasoningEfforts.length > 0 ? true : undefined,
  ].find((candidate): candidate is boolean => candidate !== undefined);
  const defaultReasoningEffort =
    nonEmptyString(value.defaultReasoningEffort) ??
    nonEmptyString(value.default_reasoning_effort) ??
    nonEmptyString(isRecord(reasoning) ? reasoning.default : undefined) ??
    nonEmptyString(isRecord(reasoning) ? reasoning.defaultEffort : undefined) ??
    nonEmptyString(isRecord(reasoning) ? reasoning.default_effort : undefined);
  const { contextWindows, defaultContextWindowTokens } = parseContextWindows(value);
  const rawName = nonEmptyString(value.name);
  return {
    id,
    name:
      nonEmptyString(value.display_name) ??
      nonEmptyString(value.displayName) ??
      (rawName?.startsWith("models/") ? undefined : rawName),
    ...(reasoningSupported !== undefined ? { reasoningSupported } : {}),
    ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(contextWindows.length > 0 ? { contextWindows, contextWindowSource } : {}),
    ...(defaultContextWindowTokens ? { defaultContextWindowTokens } : {}),
  };
}

function modelsDevModel(
  modelsDev: ModelsDevCatalog | undefined,
  provider: string,
  modelId: string,
): Record<string, unknown> | undefined {
  return modelsDev?.[provider]?.[modelId];
}

function mergeRemoteModelMetadata(
  model: RemoteModel,
  fallback: Record<string, unknown> | undefined,
): RemoteModel {
  if (!fallback) return model;
  const metadata = remoteModelFromRecord({ ...fallback, id: model.id }, "models.dev");
  if (!metadata) return model;
  return {
    ...model,
    ...(model.name === undefined && metadata.name !== undefined ? { name: metadata.name } : {}),
    ...(model.reasoningSupported === undefined && metadata.reasoningSupported !== undefined
      ? { reasoningSupported: metadata.reasoningSupported }
      : {}),
    ...(model.reasoningEfforts === undefined && metadata.reasoningEfforts !== undefined
      ? { reasoningEfforts: metadata.reasoningEfforts }
      : {}),
    ...(model.defaultReasoningEffort === undefined && metadata.defaultReasoningEffort !== undefined
      ? { defaultReasoningEffort: metadata.defaultReasoningEffort }
      : {}),
    ...(model.contextWindows === undefined && metadata.contextWindows !== undefined
      ? {
          contextWindows: metadata.contextWindows,
          contextWindowSource: "models.dev" as const,
        }
      : {}),
    ...(model.defaultContextWindowTokens === undefined &&
    metadata.defaultContextWindowTokens !== undefined
      ? { defaultContextWindowTokens: metadata.defaultContextWindowTokens }
      : {}),
  };
}

function applyCodexOAuthContextPolicy(
  model: RemoteModel,
  environment: NodeJS.ProcessEnv,
): RemoteModel {
  if (!isCodexOAuthModel(`openai-codex/${model.id}`)) return model;

  const modelSlug = `openai-codex/${model.id}`;
  const oauthContext = readCodexOAuthContextWindow(modelSlug, environment);
  const effectiveDefaultContextWindowTokens = oauthContext?.effectiveContextWindowTokens;
  const contextWindows = (model.contextWindows ?? [])
    .map((contextWindow) => {
      const tokens = normalizeCodexOAuthEffectiveContextWindowTokens(
        modelSlug,
        contextWindow.tokens,
        environment,
      );
      return tokens === undefined
        ? undefined
        : {
            ...contextWindow,
            tokens,
            id: canonicalContextWindowId(tokens),
            ...(contextWindow.tokens !== tokens
              ? { label: humanizeContextWindow(tokens) }
              : contextWindow.label
                ? { label: contextWindow.label }
                : {}),
          };
    })
    .filter((contextWindow): contextWindow is RemoteContextWindow => contextWindow !== undefined)
    .filter(
      (contextWindow, index, all) =>
        all.findIndex((candidate) => candidate.tokens === contextWindow.tokens) === index,
    );
  if (
    effectiveDefaultContextWindowTokens !== undefined &&
    !contextWindows.some(
      (contextWindow) => contextWindow.tokens === effectiveDefaultContextWindowTokens,
    )
  ) {
    contextWindows.push({
      id: canonicalContextWindowId(effectiveDefaultContextWindowTokens),
      tokens: effectiveDefaultContextWindowTokens,
      label: humanizeContextWindow(effectiveDefaultContextWindowTokens),
    });
  }
  const effectiveContextWindows =
    contextWindows.length > 0
      ? contextWindows
      : [
          {
            id: canonicalContextWindowId(effectiveDefaultContextWindowTokens ?? 258_400),
            tokens: effectiveDefaultContextWindowTokens ?? 258_400,
            label: humanizeContextWindow(effectiveDefaultContextWindowTokens ?? 258_400),
          },
        ];
  const requestedDefault = effectiveDefaultContextWindowTokens ?? model.defaultContextWindowTokens;
  const defaultContextWindowTokens = effectiveContextWindows.some(
    (contextWindow) => contextWindow.tokens === requestedDefault,
  )
    ? requestedDefault
    : effectiveContextWindows.at(-1)?.tokens;

  return {
    ...model,
    contextWindows: effectiveContextWindows,
    ...(defaultContextWindowTokens !== undefined ? { defaultContextWindowTokens } : {}),
    contextWindowSource: "oauth",
  };
}

function addKnownCodexOAuthModels(models: ReadonlyArray<RemoteModel>): ReadonlyArray<RemoteModel> {
  const knownIds = new Set(models.map((model) => model.id.trim()));
  return [...models, ...CODEX_OAUTH_KNOWN_MODELS.filter((model) => !knownIds.has(model.id))];
}

async function fetchJson(
  fetchImplementation: FetchImplementation,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error("The model endpoint returned an invalid response");
  }
  return payload;
}

function parseOpenAICompatibleModels(payload: Record<string, unknown>): ReadonlyArray<RemoteModel> {
  if (!Array.isArray(payload.data)) return [];
  return payload.data.flatMap((value) =>
    isRecord(value) ? (remoteModelFromRecord(value) ?? []) : [],
  );
}

function parseModelsDevCatalog(payload: Record<string, unknown>): ModelsDevCatalog {
  const providers: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [providerId, providerValue] of Object.entries(payload)) {
    if (!isRecord(providerValue) || !isRecord(providerValue.models)) continue;
    const models: Record<string, Record<string, unknown>> = {};
    for (const [modelId, modelValue] of Object.entries(providerValue.models)) {
      if (isRecord(modelValue)) models[modelId] = modelValue;
    }
    if (Object.keys(models).length > 0) providers[providerId] = models;
  }
  return providers;
}

async function loadModelsDevCatalog(
  fetchImplementation: FetchImplementation,
): Promise<ModelsDevCatalog | undefined> {
  try {
    return parseModelsDevCatalog(
      await fetchJson(fetchImplementation, "https://models.dev/api.json", {}),
    );
  } catch {
    return undefined;
  }
}

async function loadOpenAIModels(
  apiKey: string,
  fetchImplementation: FetchImplementation,
  _environment: NodeJS.ProcessEnv,
  modelsDev?: ModelsDevCatalog,
): Promise<ReadonlyArray<RemoteModel>> {
  const models = parseOpenAICompatibleModels(
    await fetchJson(fetchImplementation, "https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
  );
  return models.map((model) =>
    mergeRemoteModelMetadata(model, modelsDevModel(modelsDev, "openai", model.id)),
  );
}

async function loadClaudeModels(
  apiKey: string,
  fetchImplementation: FetchImplementation,
  _environment: NodeJS.ProcessEnv,
  modelsDev?: ModelsDevCatalog,
): Promise<ReadonlyArray<RemoteModel>> {
  const models: RemoteModel[] = [];
  let afterId: string | undefined;
  do {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const payload = await fetchJson(fetchImplementation, url.toString(), {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
    });
    const page = parseOpenAICompatibleModels(payload);
    models.push(...page);
    const hasMore = payload.has_more === true;
    afterId = hasMore ? nonEmptyString(payload.last_id) : undefined;
    if (hasMore && !afterId) break;
  } while (afterId);

  // Anthropic's list response contains the model ids, but capability metadata
  // is returned by the per-model endpoint. Fetch it when the list did not
  // already include the fields (the API has changed between versions).
  return Promise.all(
    models.map(async (model) => {
      if (model.reasoningSupported !== undefined && model.contextWindows?.length) {
        return mergeRemoteModelMetadata(model, modelsDevModel(modelsDev, "anthropic", model.id));
      }
      try {
        const detail = await fetchJson(
          fetchImplementation,
          `https://api.anthropic.com/v1/models/${encodeURIComponent(model.id)}`,
          {
            headers: {
              "anthropic-version": "2023-06-01",
              "x-api-key": apiKey,
            },
          },
        );
        const enriched = remoteModelFromRecord({ ...detail, id: model.id });
        return mergeRemoteModelMetadata(
          enriched ? { ...model, ...enriched } : model,
          modelsDevModel(modelsDev, "anthropic", model.id),
        );
      } catch {
        // Model discovery should remain useful when one detail request is
        // unavailable or an older Anthropic endpoint does not support it.
        return mergeRemoteModelMetadata(model, modelsDevModel(modelsDev, "anthropic", model.id));
      }
    }),
  );
}

async function loadGoogleModels(
  apiKey: string,
  fetchImplementation: FetchImplementation,
  _environment: NodeJS.ProcessEnv,
  modelsDev?: ModelsDevCatalog,
): Promise<ReadonlyArray<RemoteModel>> {
  const models: RemoteModel[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await fetchJson(fetchImplementation, url.toString(), {
      headers: { "x-goog-api-key": apiKey },
    });
    if (Array.isArray(payload.models)) {
      for (const value of payload.models) {
        if (!isRecord(value)) continue;
        const methods = Array.isArray(value.supportedGenerationMethods)
          ? value.supportedGenerationMethods
          : [];
        if (!methods.includes("generateContent")) continue;
        const id = nonEmptyString(value.name)?.replace(/^models\//u, "");
        if (!id) continue;
        models.push(remoteModelFromRecord({ ...value, id }) ?? { id });
      }
    }
    pageToken = nonEmptyString(payload.nextPageToken);
  } while (pageToken);
  return Promise.all(
    models.map(async (model) => {
      if (model.reasoningSupported !== undefined && model.contextWindows?.length) {
        return mergeRemoteModelMetadata(model, modelsDevModel(modelsDev, "google", model.id));
      }
      try {
        const detail = await fetchJson(
          fetchImplementation,
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}`,
          { headers: { "x-goog-api-key": apiKey } },
        );
        const enriched = remoteModelFromRecord({ ...detail, id: model.id });
        return mergeRemoteModelMetadata(
          enriched ? { ...model, ...enriched } : model,
          modelsDevModel(modelsDev, "google", model.id),
        );
      } catch {
        return mergeRemoteModelMetadata(model, modelsDevModel(modelsDev, "google", model.id));
      }
    }),
  );
}

async function loadCodexModels(
  _apiKey: string,
  _fetchImplementation: FetchImplementation,
  environment: NodeJS.ProcessEnv,
): Promise<ReadonlyArray<RemoteModel>> {
  const binaryPath = environment.SPARKY_CODEX_BINARY?.trim() || "codex";
  const codexHome =
    environment.SPARKY_CODEX_HOME?.trim() || environment.CODEX_HOME?.trim() || undefined;
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(binaryPath, ["app-server"], {
      env: { ...environment, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Codex model discovery timed out"));
    }, REQUEST_TIMEOUT_MS);
    const finish = (error?: Error, models?: ReadonlyArray<RemoteModel>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (message.id === 1) {
        if (isRecord(message.error)) {
          finish(new Error(nonEmptyString(message.error.message) ?? "Codex initialization failed"));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "model/list", params: {} });
        return;
      }
      if (message.id === 2) {
        if (isRecord(message.error)) {
          finish(
            new Error(nonEmptyString(message.error.message) ?? "Codex model discovery failed"),
          );
          return;
        }
        const result = isRecord(message.result) ? message.result : {};
        const data = Array.isArray(result.data) ? result.data : [];
        const models = data.flatMap((entry) =>
          isRecord(entry) ? (remoteModelFromRecord(entry) ?? []) : [],
        );
        finish(undefined, models);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.once("error", (cause) =>
      finish(cause instanceof Error ? cause : new Error(String(cause))),
    );
    child.once("close", (code) => {
      if (!settled && code !== 0) {
        finish(new Error(stderr.trim() || `Codex exited with code ${code ?? "unknown"}`));
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "sparky_desktop", title: "Sparky Desktop", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export type CodexModelLoader = (
  environment: NodeJS.ProcessEnv,
) => Promise<ReadonlyArray<RemoteModel>>;

const loadCodexModelsForDiscovery: CodexModelLoader = (environment) =>
  loadCodexModels("authenticated", globalThis.fetch, environment);

const PROVIDERS: ReadonlyArray<ProviderDefinition> = [
  {
    prefix: "openai-codex",
    label: "OpenAI Codex",
    load: loadCodexModels,
  },
  {
    env: "OPENAI_API_KEY",
    prefix: "openai",
    label: "OpenAI",
    load: loadOpenAIModels,
  },
  {
    env: "ANTHROPIC_API_KEY",
    prefix: "anthropic",
    label: "Claude",
    load: loadClaudeModels,
  },
  {
    env: "GEMINI_API_KEY",
    prefix: "google",
    label: "Google",
    load: loadGoogleModels,
  },
];

export async function discoverSparkyModels(
  environment: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation = globalThis.fetch,
  codexModelLoader: CodexModelLoader = loadCodexModelsForDiscovery,
): Promise<SparkyModelDiscovery> {
  const configured = PROVIDERS.flatMap((provider) => {
    if (!provider.env) {
      return hasCodexOAuthAuthentication(environment)
        ? [{ provider, apiKey: "authenticated" }]
        : [];
    }
    const apiKey = environment[provider.env]?.trim();
    return apiKey ? [{ provider, apiKey }] : [];
  });

  const modelsDev =
    configured.length > 0 ? await loadModelsDevCatalog(fetchImplementation) : undefined;

  const results = await Promise.all(
    configured.map(async ({ provider, apiKey }) => {
      try {
        const loadedRemoteModels =
          provider.prefix === "openai-codex"
            ? await codexModelLoader(environment)
            : await provider.load(apiKey, fetchImplementation, environment, modelsDev);
        const remoteModels =
          provider.prefix === "openai-codex"
            ? addKnownCodexOAuthModels(loadedRemoteModels)
                .map((model) =>
                  mergeRemoteModelMetadata(
                    model,
                    modelsDevModel(modelsDev, "openai-codex", model.id) ??
                      modelsDevModel(modelsDev, "openai", model.id),
                  ),
                )
                .map((model) => applyCodexOAuthContextPolicy(model, environment))
            : loadedRemoteModels;
        const seen = new Set<string>();
        const models = remoteModels.flatMap((remoteModel): ReadonlyArray<ServerProviderModel> => {
          const id = remoteModel.id.trim().replace(/^models\//u, "");
          if (!id || seen.has(id)) return [];
          seen.add(id);
          const name = remoteModel.name?.trim() || humanizeModelId(id);
          const supportedReasoningEfforts = remoteModel.reasoningEfforts ?? [];
          const defaultReasoningEffort = supportedReasoningEfforts.some(
            (effort) => effort.id === remoteModel.defaultReasoningEffort,
          )
            ? remoteModel.defaultReasoningEffort
            : undefined;
          const rawContextWindows = remoteModel.contextWindows ?? [];
          const contextWindows = rawContextWindows;
          const requestedDefaultContextWindowTokens =
            remoteModel.defaultContextWindowTokens === undefined
              ? undefined
              : remoteModel.defaultContextWindowTokens;
          const defaultContextWindowTokens = contextWindows.some(
            (contextWindow) => contextWindow.tokens === requestedDefaultContextWindowTokens,
          )
            ? requestedDefaultContextWindowTokens
            : contextWindows.length === 1
              ? contextWindows[0]?.tokens
              : undefined;
          const optionDescriptors = [
            ...(remoteModel.reasoningSupported !== false && supportedReasoningEfforts.length > 0
              ? [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select" as const,
                    options: supportedReasoningEfforts.map((effort) => ({
                      id: effort.id,
                      label: effort.label || humanizeModelId(effort.id),
                      ...(effort.id === defaultReasoningEffort ? { isDefault: true } : {}),
                    })),
                    ...(defaultReasoningEffort ? { currentValue: defaultReasoningEffort } : {}),
                  },
                ]
              : []),
            ...(contextWindows.length > 0
              ? [
                  {
                    id: "contextWindow",
                    label: "Context Window",
                    type: "select" as const,
                    options: contextWindows.map((contextWindow) => ({
                      id: contextWindow.id,
                      label: contextWindow.label || humanizeContextWindow(contextWindow.tokens),
                      ...(contextWindow.tokens === defaultContextWindowTokens
                        ? { isDefault: true }
                        : {}),
                    })),
                    ...(defaultContextWindowTokens
                      ? { currentValue: canonicalContextWindowId(defaultContextWindowTokens) }
                      : {}),
                  },
                ]
              : []),
          ];
          return [
            {
              slug: `${provider.prefix}/${id}`,
              name,
              shortName: name,
              subProvider: provider.label,
              isCustom: false,
              capabilities:
                optionDescriptors.length > 0
                  ? createModelCapabilities({ optionDescriptors })
                  : null,
              ...(remoteModel.contextWindowSource
                ? { contextWindowSource: remoteModel.contextWindowSource }
                : {}),
            },
          ];
        });
        return { models, error: undefined };
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        return {
          models: [] as ReadonlyArray<ServerProviderModel>,
          error: `${provider.label}: ${detail}`,
        };
      }
    }),
  );

  const models = results
    .flatMap((result) => result.models)
    .toSorted((left, right) => {
      const providerDelta =
        PROVIDERS.findIndex((provider) => provider.label === left.subProvider) -
        PROVIDERS.findIndex((provider) => provider.label === right.subProvider);
      return providerDelta || left.name.localeCompare(right.name, undefined, { numeric: true });
    })
    .map((model, index) => (index === 0 ? { ...model, isDefault: true } : model));

  return {
    models,
    configuredProviderCount: configured.length,
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
  };
}
