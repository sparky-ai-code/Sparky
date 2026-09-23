import type { ProviderInstanceEnvironmentVariable } from "@sparky/contracts";

export interface ModelApiCredentialTarget {
  readonly id: string;
  readonly envName: string;
}

const LEGACY_ENDPOINT_NAMES = new Set([
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "GEMINI_BASE_URL",
  "FIREWORKS_BASE_URL",
  "OLLAMA_CLOUD_BASE_URL",
]);

export function nextModelProviderEnvironment(
  existingEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  api: ModelApiCredentialTarget,
  keyValue: string,
  modelApis: ReadonlyArray<ModelApiCredentialTarget>,
): ProviderInstanceEnvironmentVariable[] {
  const providerKeyNames = new Set(modelApis.map((modelApi) => modelApi.envName));
  const environment = existingEnvironment.filter((variable) => {
    if (variable.name === api.envName) return false;
    if (api.id === "ollama-cloud" && variable.name === "OLLAMA_CLOUD_CONFIGURED") return false;
    return providerKeyNames.has(variable.name) || !LEGACY_ENDPOINT_NAMES.has(variable.name);
  });

  if (keyValue.length > 0) {
    environment.push({ name: api.envName, value: keyValue, sensitive: true, valueRedacted: false });
    if (api.id === "ollama-cloud") {
      environment.push({ name: "OLLAMA_CLOUD_CONFIGURED", value: "true", sensitive: false });
    }
  }

  return environment;
}
