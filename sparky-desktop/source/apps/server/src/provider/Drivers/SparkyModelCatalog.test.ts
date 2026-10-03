// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { discoverSparkyModels, loadCodexModels } from "./SparkyModelCatalog.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("discoverSparkyModels", () => {
  it("uses only ChatGPT Codex models returned by discovery", async () => {
    const authDirectory = NodePath.join(
      NodeOS.tmpdir(),
      `sparky-codex-models-${process.pid}-${Date.now()}`,
    );
    NodeFS.mkdirSync(authDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(authDirectory, "auth.json"),
      JSON.stringify({
        auth_mode: "siwc",
        tokens: {
          access_token: "access",
          refresh_token: "refresh",
          account_id: "account",
          client_id: "oaiapp_test",
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          resource: "https://api.openai.com/v1",
          expires: Date.now() + 3_600_000,
        },
      }),
      "utf8",
    );
    try {
      const fetchImplementation = Object.assign(
        async (_input: string | URL | Request) => jsonResponse({}),
        { preconnect: async () => undefined },
      ) as typeof fetch;
      const result = await discoverSparkyModels(
        { SPARKY_CODEX_HOME: authDirectory },
        fetchImplementation,
        async () => [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            reasoningEfforts: [
              { id: "low", description: "Fast responses with lighter reasoning" },
              { id: "medium", description: "Balances speed and reasoning depth" },
              { id: "high", description: "Greater reasoning depth for complex work" },
            ],
            defaultReasoningEffort: "medium",
            contextWindows: [
              { id: "128k", tokens: 128_000 },
              { id: "1m", tokens: 1_000_000 },
            ],
            defaultContextWindowTokens: 1_000_000,
          },
        ],
      );

      expect(result.configuredProviderCount).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.models.map((model) => model.slug)).toEqual(["openai-codex/gpt-5.6-sol"]);
      expect(result.models.every((model) => model.subProvider === "OpenAI Codex")).toBe(true);
      expect(result.models[0]?.contextWindowSource).toBe("oauth");

      const codexModel = result.models[0];
      const reasoningEffort = codexModel?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "reasoningEffort",
      );
      expect(
        reasoningEffort?.type === "select"
          ? reasoningEffort.options.map((option) => option.id)
          : undefined,
      ).toEqual(["low", "medium", "high"]);
      const contextWindow = codexModel?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "contextWindow",
      );
      expect(
        contextWindow?.type === "select"
          ? contextWindow.options.map((option) => option.id)
          : undefined,
      ).toEqual(["64k", "128k", "256k", "258400"]);
      expect(
        result.models[0]?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "reasoningEffort",
        ),
      ).toMatchObject({
        options: [
          { id: "low", label: "Low", description: "Fast responses with lighter reasoning" },
          {
            id: "medium",
            label: "Medium",
            description: "Balances speed and reasoning depth",
            isDefault: true,
          },
          {
            id: "high",
            label: "High",
            description: "Greater reasoning depth for complex work",
          },
        ],
      });
      expect(
        result.models[0]?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "contextWindow",
        ),
      ).toEqual({
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "64k", label: "64k" },
          { id: "128k", label: "128k" },
          { id: "256k", label: "256k" },
          { id: "258400", label: "258400", isDefault: true },
        ],
        currentValue: "258400",
      });
      expect(result.models[0]?.contextWindowSource).toBe("oauth");
    } finally {
      NodeFS.rmSync(authDirectory, { recursive: true, force: true });
    }
  });

  it("does not synthesize a ChatGPT model when model discovery returns none", async () => {
    const authDirectory = NodePath.join(
      NodeOS.tmpdir(),
      `sparky-codex-empty-models-${process.pid}-${Date.now()}`,
    );
    NodeFS.mkdirSync(authDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(authDirectory, "auth.json"),
      JSON.stringify({
        auth_mode: "siwc",
        tokens: {
          access_token: "access",
          refresh_token: "refresh",
          account_id: "account",
          client_id: "oaiapp_test",
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          resource: "https://api.openai.com/v1",
          expires: Date.now() + 3_600_000,
        },
      }),
      "utf8",
    );
    try {
      const fetchImplementation = Object.assign(async () => jsonResponse({}), {
        preconnect: async () => undefined,
      }) as typeof fetch;
      const result = await discoverSparkyModels(
        { SPARKY_CODEX_HOME: authDirectory },
        fetchImplementation,
        async () => [],
      );

      expect(result.configuredProviderCount).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.models).toEqual([]);
    } finally {
      NodeFS.rmSync(authDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the hardcoded ChatGPT model IDs and enriches their metadata", async () => {
    const authDirectory = NodePath.join(
      NodeOS.tmpdir(),
      `sparky-codex-live-catalog-${process.pid}-${Date.now()}`,
    );
    NodeFS.mkdirSync(authDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(authDirectory, "auth.json"),
      JSON.stringify({
        auth_mode: "siwc",
        tokens: {
          access_token: "private-access-token",
          refresh_token: "private-refresh-token",
          account_id: "account-123",
          client_id: "oaiapp_test",
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          resource: "https://api.openai.com/v1",
          expires: Date.now() + 3_600_000,
        },
      }),
      "utf8",
    );
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return jsonResponse({
        models: [
          {
            slug: "gpt-6.1-sol",
            display_name: "GPT Live",
            visibility: "list",
            context_window: 272_000,
            max_context_window: 372_000,
            default_reasoning_level: "medium",
            supported_reasoning_levels: [
              { effort: "low", description: "Fast" },
              { effort: "medium", description: "Balanced" },
              { effort: "high", description: "Deep" },
              { effort: "xhigh", description: "Very deep" },
              { effort: "max", description: "Maximum" },
              { effort: "ultra", description: "Codex-only delegation" },
            ],
          },
          { slug: "old-retired-model", visibility: "hidden" },
        ],
      });
    }) as typeof fetch;

    try {
      const models = await loadCodexModels("", fetchImplementation, {
        SPARKY_CODEX_HOME: authDirectory,
      });
      expect(models.map((model) => model.id)).toEqual([
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]);
      expect(models[0]).toMatchObject({
        name: "GPT-6.1 Sol",
        reasoningSupported: true,
        reasoningEfforts: [
          { id: "low", description: "Fast" },
          { id: "medium", description: "Balanced" },
          { id: "high", description: "Deep" },
          { id: "xhigh", description: "Very deep" },
          { id: "max", description: "Maximum" },
          { id: "ultra", description: "Codex-only delegation" },
        ],
        defaultReasoningEffort: "medium",
        contextWindows: [
          { id: "272k", tokens: 272_000 },
          { id: "372k", tokens: 372_000 },
        ],
      });
      const request = requests[0];
      expect(request?.url).toBe("https://api.openai.com/v1/models");
      expect(request?.headers.get("authorization")).toBe("Bearer private-access-token");
      expect(request?.headers.get("chatgpt-account-id")).toBeNull();
      expect(request?.headers.get("originator")).toBeNull();
    } finally {
      NodeFS.rmSync(authDirectory, { recursive: true, force: true });
    }
  });

  it("excludes GPT-5.5 and other models absent from the hardcoded ChatGPT list", async () => {
    const authDirectory = NodePath.join(
      NodeOS.tmpdir(),
      `sparky-codex-chatgpt-models-${process.pid}-${Date.now()}`,
    );
    NodeFS.mkdirSync(authDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(authDirectory, "auth.json"),
      JSON.stringify({
        auth_mode: "siwc",
        tokens: {
          access_token: "chatgpt-access-token",
          refresh_token: "refresh",
          client_id: "oaiapp_test",
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          resource: "https://api.openai.com/v1",
          expires: Date.now() + 3_600_000,
        },
      }),
      "utf8",
    );
    const fetchImplementation = (async () =>
      jsonResponse({
        models: [
          { slug: "gpt-6.1-sol", visibility: "hide" },
          { slug: "gpt-5.5", visibility: "list" },
          { slug: "catalog-extra-model", visibility: "list" },
        ],
      })) as unknown as typeof fetch;

    try {
      const models = await loadCodexModels("", fetchImplementation, {
        SPARKY_CODEX_HOME: authDirectory,
      });
      expect(models.map((model) => model.id)).toEqual([
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]);
      expect(models.some((model) => model.id === "gpt-5.5")).toBe(false);
    } finally {
      NodeFS.rmSync(authDirectory, { recursive: true, force: true });
    }
  });

  it("uses Sparky-owned credentials instead of CODEX_HOME", async () => {
    const home = NodePath.join(NodeOS.tmpdir(), `sparky-auth-home-${process.pid}-${Date.now()}`);
    const sparkyAuthDirectory = NodePath.join(home, ".sparky", "codex-auth");
    const codexAuthDirectory = NodePath.join(home, "installed-codex");
    NodeFS.mkdirSync(sparkyAuthDirectory, { recursive: true });
    NodeFS.mkdirSync(codexAuthDirectory, { recursive: true });
    const writeCredentials = (directory: string, accountId: string) =>
      NodeFS.writeFileSync(
        NodePath.join(directory, "auth.json"),
        JSON.stringify({
          auth_mode: "siwc",
          tokens: {
            access_token: `${accountId}-token`,
            refresh_token: "refresh",
            account_id: accountId,
            client_id: "oaiapp_test",
            scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            resource: "https://api.openai.com/v1",
            expires: Date.now() + 3_600_000,
          },
        }),
        "utf8",
      );
    writeCredentials(sparkyAuthDirectory, "sparky-account");
    writeCredentials(codexAuthDirectory, "codex-account");
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return jsonResponse({ models: [] });
    }) as typeof fetch;

    try {
      const models = await loadCodexModels("", fetchImplementation, {
        HOME: home,
        CODEX_HOME: codexAuthDirectory,
      });
      expect(models.map((model) => model.id)).toContain("gpt-6.1-sol");
      expect(models.some((model) => model.id === "gpt-5.5")).toBe(false);
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer sparky-account-token");
      expect(requests[0]?.headers.get("chatgpt-account-id")).toBeNull();
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses Models.dev context metadata when OAuth Codex model/list omits it", async () => {
    const authDirectory = NodePath.join(
      NodeOS.tmpdir(),
      `sparky-codex-models-fallback-${process.pid}-${Date.now()}`,
    );
    NodeFS.mkdirSync(authDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(authDirectory, "auth.json"),
      JSON.stringify({
        auth_mode: "siwc",
        tokens: {
          access_token: "access",
          refresh_token: "refresh",
          account_id: "account",
          client_id: "oaiapp_test",
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          resource: "https://api.openai.com/v1",
          expires: Date.now() + 3_600_000,
        },
      }),
      "utf8",
    );
    try {
      const fetchImplementation = Object.assign(
        async (input: string | URL | Request) =>
          String(input) === "https://models.dev/api.json"
            ? jsonResponse({ openai: { models: { "gpt-5.6-codex": { context_length: "1m" } } } })
            : jsonResponse({}),
        { preconnect: async () => undefined },
      ) as typeof fetch;
      const result = await discoverSparkyModels(
        { SPARKY_CODEX_HOME: authDirectory },
        fetchImplementation,
        async () => [{ id: "gpt-5.6-codex", name: "GPT-5.6 Codex" }],
      );

      expect(
        result.models[0]?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "contextWindow",
        ),
      ).toEqual({
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "64k", label: "64k" },
          { id: "128k", label: "128k" },
          { id: "256k", label: "256k" },
          { id: "258400", label: "258400", isDefault: true },
        ],
        currentValue: "258400",
      });
    } finally {
      NodeFS.rmSync(authDirectory, { recursive: true, force: true });
    }
  });

  it("fetches and namespaces every configured provider catalog", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.startsWith("https://api.openai.com/")) {
        return jsonResponse({
          data: [
            {
              id: "gpt-test",
              supportedReasoningEfforts: ["low", "high"],
              defaultReasoningEffort: "unsupported",
            },
            {
              id: "gpt-6-astra",
              display_name: "GPT-6 Astra",
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
              defaultReasoningEffort: "medium",
            },
          ],
        });
      }
      if (url.startsWith("https://api.anthropic.com/")) {
        return jsonResponse({
          data: [
            {
              id: "claude-test",
              display_name: "Claude Test",
              supported_reasoning_efforts: ["medium"],
              default_reasoning_effort: "medium",
              context_window: "200k",
            },
          ],
          has_more: false,
        });
      }
      if (url.startsWith("https://generativelanguage.googleapis.com/")) {
        return jsonResponse({
          models: [
            {
              name: "models/gemini-test",
              displayName: "Gemini Test",
              supportedGenerationMethods: ["generateContent"],
              inputTokenLimit: 1_048_576,
            },
            {
              name: "models/embedding-test",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        });
      }
      if (url === "https://models.dev/api.json") {
        return jsonResponse({
          openai: {
            models: {
              "gpt-test": { context_length: "1m" },
            },
          },
        });
      }
      return jsonResponse({ data: [] });
    }) as typeof fetch;

    const result = await discoverSparkyModels(
      {
        OPENAI_API_KEY: "openai-secret",
        ANTHROPIC_API_KEY: "claude-secret",
        GEMINI_API_KEY: "google-secret",
        OPENCODE_API_KEY: "zen-secret",
      },
      fetchImplementation,
    );

    expect(result.configuredProviderCount).toBe(3);
    expect(result.errors).toEqual([]);
    expect(result.models.map((model) => [model.slug, model.subProvider])).toEqual([
      ["openai/gpt-test", "OpenAI"],
      ["openai/gpt-6-astra", "OpenAI"],
      ["anthropic/claude-test", "Claude"],
      ["google/gemini-test", "Google"],
    ]);
    expect(
      requests.find((request) => request.url.includes("openai.com"))?.headers.get("authorization"),
    ).toBe("Bearer openai-secret");
    expect(
      requests.find((request) => request.url.includes("anthropic.com"))?.headers.get("x-api-key"),
    ).toBe("claude-secret");
    expect(
      requests
        .find((request) => request.url.includes("googleapis.com"))
        ?.headers.get("x-goog-api-key"),
    ).toBe("google-secret");

    const openAi = result.models.find((model) => model.slug === "openai/gpt-test");
    expect(
      openAi?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "reasoningEffort",
      ),
    ).toEqual({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    });
    expect(
      openAi?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "contextWindow",
      ),
    ).toEqual({
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [{ id: "1m", label: "1M", isDefault: true }],
      currentValue: "1m",
    });

    const google = result.models.find((model) => model.slug === "google/gemini-test");
    expect(
      google?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "contextWindow",
      ),
    ).toEqual({
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [{ id: "1048576", label: "1048576", isDefault: true }],
      currentValue: "1048576",
    });

    for (const slug of ["anthropic/claude-test"]) {
      expect(
        result.models
          .find((model) => model.slug === slug)
          ?.capabilities?.optionDescriptors?.some(
            (descriptor) => descriptor.id === "contextWindow",
          ),
      ).toBe(true);
    }
  });

  it("keeps successful catalogs when another provider rejects its key", async () => {
    const fetchImplementation = (async (input: string | URL | Request) =>
      String(input).includes("openai.com")
        ? jsonResponse({ message: "invalid key" }, 401)
        : jsonResponse({ data: [{ id: "zen-test" }] })) as typeof fetch;

    const result = await discoverSparkyModels(
      { OPENAI_API_KEY: "bad", ANTHROPIC_API_KEY: "valid" },
      fetchImplementation,
    );

    expect(result.models.map((model) => model.slug)).toEqual(["anthropic/zen-test"]);
    expect(result.errors).toEqual(["OpenAI: HTTP 401"]);
  });

  it("loads nested Anthropic capabilities from the per-model endpoint", async () => {
    const requests: string[] = [];
    const fetchImplementation = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (new URL(url).pathname.endsWith("/v1/models")) {
        return jsonResponse({
          data: [{ id: "claude-capabilities-test", display_name: "Claude Capabilities Test" }],
          has_more: false,
        });
      }
      return jsonResponse({
        id: "claude-capabilities-test",
        capabilities: {
          effort: {
            low: { supported: true },
            high: { supported: true },
            xhigh: { supported: true },
            max: { supported: true },
            default: "max",
          },
          context: { max_input_tokens: 200_000 },
        },
      });
    }) as typeof fetch;

    const result = await discoverSparkyModels(
      { ANTHROPIC_API_KEY: "claude-secret" },
      fetchImplementation,
    );
    const model = result.models.find(
      (entry) => entry.slug === "anthropic/claude-capabilities-test",
    );

    expect(requests).toContain("https://api.anthropic.com/v1/models/claude-capabilities-test");
    expect(model?.capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Xhigh" },
          { id: "max", label: "Max", isDefault: true },
        ],
        currentValue: "max",
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [{ id: "200k", label: "200k", isDefault: true }],
        currentValue: "200k",
      },
    ]);
  });

  it("fetches Google details and enriches incomplete models from Models.dev", async () => {
    const requests: string[] = [];
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://models.dev/api.json") {
        return jsonResponse({
          google: {
            models: {
              "gemini-no-metadata": {
                name: "Gemini No Metadata",
                reasoning: true,
                reasoning_options: [
                  { type: "effort", values: ["minimal", "low", "medium", "high"] },
                ],
                limit: { context: 999_999 },
              },
            },
          },
        });
      }
      if (url === "https://api.anthropic.com/v1/models?limit=1000") {
        return jsonResponse({ data: [{ id: "claude-no-metadata" }], has_more: false });
      }
      if (url === "https://api.anthropic.com/v1/models/claude-no-metadata") {
        return jsonResponse({
          id: "claude-no-metadata",
          capabilities: {
            effort: {
              low: { supported: true },
              high: { supported: true },
              max: { supported: true },
              default: "high",
            },
          },
          max_input_tokens: 200_000,
        });
      }
      if (url.startsWith("https://generativelanguage.googleapis.com/")) {
        if (url.endsWith("/v1beta/models/gemini-no-metadata")) {
          expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("google-secret");
          return jsonResponse({
            name: "models/gemini-no-metadata",
            thinking: true,
            inputTokenLimit: 1_048_576,
          });
        }
        return jsonResponse({
          models: [
            {
              name: "models/gemini-no-metadata",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        });
      }
      return jsonResponse({ data: [{ id: "zen-no-metadata" }] });
    }) as typeof fetch;

    const result = await discoverSparkyModels(
      {
        ANTHROPIC_API_KEY: "claude-secret",
        GEMINI_API_KEY: "google-secret",
        OPENCODE_API_KEY: "zen-secret",
      },
      fetchImplementation,
    );

    expect(requests).toContain(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-no-metadata",
    );
    expect(requests.filter((url) => url === "https://models.dev/api.json")).toHaveLength(1);

    expect(
      result.models
        .find((model) => model.slug === "anthropic/claude-no-metadata")
        ?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "reasoningEffort",
        ),
    ).toMatchObject({
      options: [{ id: "low" }, { id: "high" }, { id: "max" }],
    });

    expect(
      result.models
        .find((model) => model.slug === "google/gemini-no-metadata")
        ?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "reasoningEffort",
        ),
    ).toMatchObject({
      options: [{ id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    });
    expect(
      result.models
        .find((model) => model.slug === "google/gemini-no-metadata")
        ?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "contextWindow"),
    ).toMatchObject({ options: [{ id: "1048576" }] });
  });

  it("keeps models when optional metadata fails and does not fabricate unsupported effort", async () => {
    const fetchImplementation = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://models.dev/api.json") return jsonResponse({}, 503);
      if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?")) {
        return jsonResponse({
          models: [
            {
              name: "models/gemini-no-thinking",
              supportedGenerationMethods: ["generateContent"],
              thinking: false,
              inputTokenLimit: 32_768,
            },
          ],
        });
      }
      return jsonResponse({ data: [{ id: "zen-without-metadata" }] });
    }) as typeof fetch;

    const result = await discoverSparkyModels(
      { GEMINI_API_KEY: "google-secret" },
      fetchImplementation,
    );

    expect(result.errors).toEqual([]);
    expect(result.models.map((model) => model.slug)).toEqual(["google/gemini-no-thinking"]);
    expect(
      result.models
        .find((model) => model.slug === "google/gemini-no-thinking")
        ?.capabilities?.optionDescriptors?.some(
          (descriptor) => descriptor.id === "reasoningEffort",
        ),
    ).toBe(false);
  });

  it("discovers Fireworks, Ollama Cloud, Cerebras, and Groq as OpenAI-compatible providers", async () => {
    const requests: string[] = [];
    const fetchImplementation = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://api.fireworks.ai/inference/v1/models") {
        return jsonResponse({ data: [{ id: "accounts/fireworks/models/llama-v3p1" }] });
      }
      if (url === "https://ollama.com/v1/models") {
        return jsonResponse({ data: [{ id: "llama3.2" }] });
      }
      if (url === "https://api.cerebras.ai/v1/models") {
        return jsonResponse({ data: [{ id: "llama-3.3-70b" }] });
      }
      if (url === "https://api.groq.com/openai/v1/models") {
        return jsonResponse({ data: [{ id: "llama-3.3-70b-versatile" }] });
      }
      return jsonResponse({});
    }) as typeof fetch;

    const result = await discoverSparkyModels(
      {
        FIREWORKS_API_KEY: "fireworks-secret",
        OLLAMA_API_KEY: "ollama-secret",
        OLLAMA_CLOUD_CONFIGURED: "true",
        CEREBRAS_API_KEY: "cerebras-secret",
        GROQ_API_KEY: "groq-secret",
      },
      fetchImplementation,
    );

    expect(requests).toContain("https://api.fireworks.ai/inference/v1/models");
    expect(requests).toContain("https://ollama.com/v1/models");
    expect(requests).toContain("https://api.cerebras.ai/v1/models");
    expect(requests).toContain("https://api.groq.com/openai/v1/models");
    expect(result.models.map((model) => [model.slug, model.subProvider])).toEqual([
      ["fireworks/accounts/fireworks/models/llama-v3p1", "Fireworks"],
      ["ollama-cloud/llama3.2", "Ollama Cloud"],
      ["cerebras/llama-3.3-70b", "Cerebras"],
      ["groq/llama-3.3-70b-versatile", "Groq"],
    ]);
  });
});
