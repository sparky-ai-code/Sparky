import type { ProviderDriverKind, ProviderInstanceId } from "@sparky/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { isProviderInstancePickerReady } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";
import { getModelProviderPresentation } from "./providerIconUtils";

export type CompactModelProviderGroup = {
  readonly id: string;
  readonly label: string;
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly instance: ProviderInstanceEntry;
  readonly models: ReadonlyArray<ModelEsque>;
};

function groupLabel(entry: ProviderInstanceEntry, model: ModelEsque): string {
  if (entry.driverKind !== "sparky") return entry.displayName;
  return (
    getModelProviderPresentation(model)?.label ?? model.subProvider?.trim() ?? entry.displayName
  );
}

export function buildCompactModelProviderGroups(input: {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey?: string | null;
}): ReadonlyArray<CompactModelProviderGroup> {
  const groups = new Map<string, CompactModelProviderGroup>();

  for (const entry of input.instanceEntries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    if (input.lockedProvider !== null && entry.driverKind !== input.lockedProvider) continue;
    if (
      input.lockedProvider !== null &&
      input.lockedContinuationGroupKey &&
      entry.continuationGroupKey !== input.lockedContinuationGroupKey
    ) {
      continue;
    }

    for (const model of input.modelOptionsByInstance.get(entry.instanceId) ?? []) {
      const label = groupLabel(entry, model);
      const id = `${entry.instanceId}\u0000${label}`;
      const existing = groups.get(id);
      if (existing) {
        groups.set(id, { ...existing, models: [...existing.models, model] });
      } else {
        groups.set(id, {
          id,
          label,
          instanceId: entry.instanceId,
          driverKind: entry.driverKind,
          instance: entry,
          models: [model],
        });
      }
    }
  }

  return [...groups.values()];
}

export function findCompactModelProviderGroup(
  groups: ReadonlyArray<CompactModelProviderGroup>,
  instanceId: ProviderInstanceId,
  modelSlug: string,
): CompactModelProviderGroup | null {
  return (
    groups.find(
      (group) =>
        group.instanceId === instanceId && group.models.some((model) => model.slug === modelSlug),
    ) ?? null
  );
}
