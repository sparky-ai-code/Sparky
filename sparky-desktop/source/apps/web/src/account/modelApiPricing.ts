type UsageTokens = {
  readonly inputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningOutputTokens?: number | undefined;
};

type ModelApiPricing = {
  readonly inputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly cachedInputIncludedInInput: boolean;
};

const MODEL_API_PRICING: Readonly<Record<string, ModelApiPricing>> = {
  // OpenAI API list prices: https://developers.openai.com/api/docs/pricing
  "gpt-6-astra": {
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 50,
    cachedInputIncludedInInput: true,
  },
  "gpt-6.1-sol": {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 10,
    cachedInputIncludedInInput: true,
  },
  "gpt-6.1-terra": {
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.05,
    outputUsdPerMillion: 5,
    cachedInputIncludedInInput: true,
  },
  "gpt-6-sol": {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 10,
    cachedInputIncludedInInput: true,
  },
  "gpt-6-luna": {
    inputUsdPerMillion: 0.1,
    cachedInputUsdPerMillion: 0.01,
    outputUsdPerMillion: 0.5,
    cachedInputIncludedInInput: true,
  },
  "gpt-5.6-sol": {
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    outputUsdPerMillion: 20,
    cachedInputIncludedInInput: true,
  },
  "gpt-5.6-terra": {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 12,
    cachedInputIncludedInInput: true,
  },
  "gpt-5.6-luna": {
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.2,
    cachedInputIncludedInInput: true,
  },
  // Anthropic API list prices: https://platform.claude.com/docs/en/about-claude/pricing
  "claude-sonnet-4-6": {
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
    cachedInputIncludedInInput: false,
  },
  "claude-opus-4-6": {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
    cachedInputIncludedInInput: false,
  },
  "claude-haiku-4-5": {
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 5,
    cachedInputIncludedInInput: false,
  },
};

/** Returns a list-price API estimate only when exact pricing and token breakdown are known. */
export function estimateModelApiCostUsd(model: string, usage: UsageTokens): number | undefined {
  const normalizedModel = model.trim().toLowerCase();
  const modelId = normalizedModel.slice(normalizedModel.lastIndexOf("/") + 1);
  const pricing = MODEL_API_PRICING[normalizedModel] ?? MODEL_API_PRICING[modelId];
  const { inputTokens, cachedInputTokens = 0, outputTokens, reasoningOutputTokens = 0 } = usage;
  if (
    !pricing ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(cachedInputTokens) ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(reasoningOutputTokens) ||
    inputTokens < 0 ||
    cachedInputTokens < 0 ||
    cachedInputTokens > inputTokens ||
    outputTokens < 0 ||
    reasoningOutputTokens < 0
  ) {
    return undefined;
  }

  const billableInputTokens = pricing.cachedInputIncludedInInput
    ? inputTokens - cachedInputTokens
    : inputTokens;
  const billableOutputTokens = outputTokens + reasoningOutputTokens;
  return (
    (billableInputTokens * pricing.inputUsdPerMillion +
      cachedInputTokens * pricing.cachedInputUsdPerMillion +
      billableOutputTokens * pricing.outputUsdPerMillion) /
    1_000_000
  );
}
