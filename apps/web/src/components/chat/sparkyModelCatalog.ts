import type { ModelCatalogSectionId } from "./ModelPickerSidebar";

const SUB_PROVIDERS_BY_CATALOG: Readonly<Record<string, ReadonlyArray<string>>> = {
  "catalog:Claude": ["Claude"],
  "catalog:OpenAI": ["OpenAI", "OpenAI Codex"],
  "catalog:Google": ["Google"],
  "catalog:OpenCode Zen": ["OpenCode Zen"],
};

export function isModelInSparkyCatalog(
  catalogId: ModelCatalogSectionId,
  subProvider: string | undefined,
): boolean {
  if (!subProvider) return false;
  return SUB_PROVIDERS_BY_CATALOG[catalogId]?.includes(subProvider) ?? false;
}
