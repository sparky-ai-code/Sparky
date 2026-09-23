import { describe, expect, it } from "vite-plus/test";

import { nextModelProviderEnvironment } from "./modelProviderEnvironment";

const api = { id: "openai", envName: "OPENAI_API_KEY" } as const;
const modelApis = [
  api,
  { id: "anthropic", envName: "ANTHROPIC_API_KEY" },
  { id: "google", envName: "GEMINI_API_KEY" },
  { id: "fireworks", envName: "FIREWORKS_API_KEY" },
  { id: "ollama-cloud", envName: "OLLAMA_API_KEY" },
] as const;
const existing = [
  { name: "OPENAI_API_KEY", value: "old-key", sensitive: true },
  { name: "ANTHROPIC_API_KEY", value: "anthropic-key", sensitive: true },
  { name: "OPENAI_BASE_URL", value: "https://legacy.example", sensitive: false },
  { name: "CUSTOM_PROVIDER_SETTING", value: "preserve-me", sensitive: false },
] as const;

describe("model provider API key environment", () => {
  it("adds and replaces a provider key while preserving other settings", () => {
    const environment = nextModelProviderEnvironment(existing, api, "new-key", modelApis);

    expect(environment).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "anthropic-key", sensitive: true },
      { name: "CUSTOM_PROVIDER_SETTING", value: "preserve-me", sensitive: false },
      { name: "OPENAI_API_KEY", value: "new-key", sensitive: true, valueRedacted: false },
    ]);
  });

  it("removes a provider key without dropping other keys or custom settings", () => {
    const environment = nextModelProviderEnvironment(existing, api, "", modelApis);

    expect(environment).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "anthropic-key", sensitive: true },
      { name: "CUSTOM_PROVIDER_SETTING", value: "preserve-me", sensitive: false },
    ]);
  });

  it("keeps the Ollama Cloud marker in sync with its API key", () => {
    const ollama = { id: "ollama-cloud", envName: "OLLAMA_API_KEY" } as const;
    const withKey = nextModelProviderEnvironment([], ollama, "ollama-key", modelApis);

    expect(withKey).toEqual([
      { name: "OLLAMA_API_KEY", value: "ollama-key", sensitive: true, valueRedacted: false },
      { name: "OLLAMA_CLOUD_CONFIGURED", value: "true", sensitive: false },
    ]);
    expect(nextModelProviderEnvironment(withKey, ollama, "", modelApis)).toEqual([]);
  });
});
