import type {
  ModelSelection,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@sparky/contracts";

export type ContextWindowSource = "provider" | "oauth" | "models.dev";

export function isAuthoritativeContextWindowSource(
  source: ContextWindowSource | undefined,
): boolean {
  return source === "provider" || source === "oauth";
}

const CONTEXT_WINDOW_OPTION_ID = "contextWindow";

/**
 * Parse the human-readable context values used by provider catalogs and old
 * persisted selections. The parser deliberately has no product-wide cap or
 * default: an unknown value remains unknown until a provider reports one.
 */
export function parseContextWindowTokens(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replaceAll(",", "");
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(?:\s*(tokens?|k|m|b))?$/u);
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

export function formatContextWindowTokens(tokens: number): string {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new Error(`Context window must be a positive safe integer, received ${tokens}.`);
  }
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return String(tokens);
}

export function getModelSelectionContextWindowTokens(
  selection: ModelSelection | undefined,
): number | undefined {
  const value = selection?.options?.find((option) => option.id === CONTEXT_WINDOW_OPTION_ID)?.value;
  return parseContextWindowTokens(value);
}

export function withModelSelectionContextWindow(
  selection: ModelSelection,
  tokens: number,
  source: ContextWindowSource = "provider",
): ModelSelection {
  const value = formatContextWindowTokens(tokens);
  const options: Array<ProviderOptionSelection> = [...(selection.options ?? [])];
  const existingIndex = options.findIndex((option) => option.id === CONTEXT_WINDOW_OPTION_ID);
  const nextOption = { id: CONTEXT_WINDOW_OPTION_ID, value } satisfies ProviderOptionSelection;
  if (existingIndex >= 0) {
    options[existingIndex] = nextOption;
  } else {
    options.push(nextOption);
  }
  return {
    ...selection,
    options,
    contextWindowSource: source,
  };
}

export function withModelSelectionContextSource(
  selection: ModelSelection,
  source: ContextWindowSource | undefined,
): ModelSelection {
  if (source === undefined) {
    if (selection.contextWindowSource === undefined) return selection;
    const { contextWindowSource: _ignored, ...withoutSource } = selection;
    return withoutSource;
  }
  return { ...selection, contextWindowSource: source };
}

export function sameModelSelectionModel(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.instanceId === right.instanceId &&
    left.model === right.model
  );
}

const contextWindowDescriptor = (model: ServerProviderModel) =>
  model.capabilities?.optionDescriptors?.find(
    (descriptor) => descriptor.id === CONTEXT_WINDOW_OPTION_ID,
  );

/**
 * Keep a selected model's context capability stable while provider discovery
 * refreshes. A catalog fallback can fill a missing capability, but it cannot
 * replace a value already observed for this provider/model. A provider
 * response that contains a context capability is authoritative and may change
 * the value.
 */
export function mergeStableModelContext(
  previous: ServerProviderModel,
  next: ServerProviderModel,
): ServerProviderModel {
  const previousContext = contextWindowDescriptor(previous);
  if (!previousContext) {
    return next;
  }

  const nextContext = contextWindowDescriptor(next);
  if (nextContext && isAuthoritativeContextWindowSource(next.contextWindowSource)) {
    return next;
  }

  if (!next.capabilities) {
    return {
      ...next,
      capabilities: previous.capabilities,
      ...(previous.contextWindowSource
        ? { contextWindowSource: previous.contextWindowSource }
        : {}),
    };
  }

  return {
    ...next,
    contextWindowSource: previous.contextWindowSource ?? next.contextWindowSource,
    capabilities: {
      ...next.capabilities,
      optionDescriptors: [
        ...(next.capabilities.optionDescriptors ?? []).filter(
          (descriptor) => descriptor.id !== "contextWindow",
        ),
        previousContext,
      ],
    },
  };
}
