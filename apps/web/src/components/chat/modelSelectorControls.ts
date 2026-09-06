import type { ProviderInstanceId } from "@sparky/contracts";

export type ModelSelectorReasoningOption = {
  id: string;
  label: string;
};

export type ModelSelectorReasoningControl = {
  label: string;
  value: string;
  valueLabel: string;
  options: ReadonlyArray<ModelSelectorReasoningOption>;
  disabled: boolean;
  disabledHint?: string;
  onSelect: (value: string) => void;
};

export type ModelSelectorFastControl = {
  enabled: boolean;
  onToggle: () => void;
};

export type ModelSelectorControls = {
  reasoning?: ModelSelectorReasoningControl;
  fast?: ModelSelectorFastControl;
};

type Registration = {
  owner: symbol;
  controls: ModelSelectorControls;
};

const registrations = new Map<ProviderInstanceId, Registration>();
const listeners = new Set<() => void>();

export function subscribeModelSelectorControls(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getModelSelectorControls(
  instanceId: ProviderInstanceId,
): ModelSelectorControls | null {
  return registrations.get(instanceId)?.controls ?? null;
}

export function publishModelSelectorControls(
  instanceId: ProviderInstanceId,
  owner: symbol,
  controls: ModelSelectorControls,
): void {
  registrations.set(instanceId, { owner, controls });
  for (const listener of listeners) {
    listener();
  }
}

export function clearModelSelectorControls(instanceId: ProviderInstanceId, owner: symbol): void {
  const registration = registrations.get(instanceId);
  if (!registration || registration.owner !== owner) {
    return;
  }
  registrations.delete(instanceId);
  for (const listener of listeners) {
    listener();
  }
}
