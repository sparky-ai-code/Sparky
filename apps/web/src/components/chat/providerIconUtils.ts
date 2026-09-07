import { ProviderDriverKind } from "@sparky/contracts";
import { ClaudeAI, Gemini, Icon, OpenAI, SparkyIcon } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("sparky")]: SparkyIcon,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
};

export type ModelProviderPresentation = {
  label: string;
  Icon: Icon;
};

const MODEL_PROVIDER_PRESENTATION_BY_LABEL: Readonly<Record<string, ModelProviderPresentation>> = {
  Claude: { label: "Claude", Icon: ClaudeAI },
  Google: { label: "Google", Icon: Gemini },
  OpenAI: { label: "OpenAI", Icon: OpenAI },
  "OpenAI Codex": { label: "OpenAI Codex", Icon: OpenAI },
};

/** Resolve the actual model vendor, rather than the Sparky runtime serving it. */
export function getModelProviderPresentation(
  model: Pick<ModelEsque, "slug" | "subProvider">,
): ModelProviderPresentation | null {
  const subProvider = model.subProvider?.trim();
  if (subProvider) {
    const exact = MODEL_PROVIDER_PRESENTATION_BY_LABEL[subProvider];
    if (exact) return exact;
  }

  const slug = model.slug.toLowerCase();
  if (slug.startsWith("anthropic/") || slug.startsWith("claude")) {
    return MODEL_PROVIDER_PRESENTATION_BY_LABEL.Claude ?? null;
  }
  if (slug.startsWith("google/") || slug.startsWith("gemini")) {
    return MODEL_PROVIDER_PRESENTATION_BY_LABEL.Google ?? null;
  }
  if (slug.startsWith("openai-codex/")) {
    return MODEL_PROVIDER_PRESENTATION_BY_LABEL["OpenAI Codex"] ?? null;
  }
  if (slug.startsWith("openai/") || slug.startsWith("gpt-")) {
    return MODEL_PROVIDER_PRESENTATION_BY_LABEL.OpenAI ?? null;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

function slugProviderQualifier(slug: string): string | null {
  const separatorIndex = slug.indexOf("/");
  if (separatorIndex <= 0) return null;
  return slug.slice(0, separatorIndex).trim() || null;
}

const MODEL_WORD_DISPLAY: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  gpt: "GPT",
  grok: "Grok",
  kimi: "Kimi",
  llama: "Llama",
  mistral: "Mistral",
  qwen: "Qwen",
};

/**
 * Turn API-style identifiers into labels without inventing provider-specific
 * mappings. Known family words get their canonical casing, while version
 * strings and unknown tokens are preserved.
 */
function humanizeModelIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.includes("-") && !trimmed.includes("_"))) return trimmed;

  return trimmed
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((token, index) => {
      const canonical = MODEL_WORD_DISPLAY[token.toLowerCase()];
      if (canonical) return canonical;
      if (index === 0 && /^[a-z]/u.test(token)) {
        return `${token[0]?.toUpperCase() ?? ""}${token.slice(1)}`;
      }
      return token;
    })
    .join(" ");
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  const withoutSubProvider = stripLeadingQualifier(name, model.subProvider);
  const withoutSlugProvider = stripLeadingQualifier(
    withoutSubProvider,
    slugProviderQualifier(model.slug),
  );
  return humanizeModelIdentifier(withoutSlugProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
