import type { ModelCatalogSectionId } from "./ModelPickerSidebar";

const SUB_PROVIDERS_BY_CATALOG: Readonly<Record<string, ReadonlyArray<string>>> = {
  "catalog:Claude": ["Claude"],
  "catalog:OpenAI": ["OpenAI", "OpenAI Codex"],
  "catalog:Google": ["Google"],
  "catalog:Fireworks": ["Fireworks"],
  "catalog:Ollama Cloud": ["Ollama Cloud"],
};

export function isModelInSparkyCatalog(
  catalogId: ModelCatalogSectionId,
  subProvider: string | undefined,
): boolean {
  if (!subProvider) return false;
  return SUB_PROVIDERS_BY_CATALOG[catalogId]?.includes(subProvider) ?? false;
}
