import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import {
  BoxesIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  LoaderCircleIcon,
  SaveIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@sparky/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@sparky/client-runtime/state/runtime";

import {
  useClientSettingsHydrated,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { fetchPrimaryEnvironment } from "../../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryEnvironment } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI, Gemini, OpenAI, OpenCodeIcon, SparkyIcon } from "../Icons";
import {
  getDisplayModelName,
  getModelProviderPresentation,
} from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

const SPARKY_INSTANCE_ID = ProviderInstanceId.make("sparky");
const SPARKY_DRIVER = ProviderDriverKind.make("sparky");
const CODEX_AUTH_PATH = "/api/sparky/codex-auth";

type CodexAuthStatus = {
  readonly authenticated: boolean;
  readonly accountId?: string | null;
  readonly expires?: number | null;
};

async function codexAuthRequest(path = "", method = "GET"): Promise<CodexAuthStatus> {
  const requestUrl = resolvePrimaryEnvironmentHttpUrl(`${CODEX_AUTH_PATH}${path}`);
  let response: Response;
  try {
    response = await fetchPrimaryEnvironment(requestUrl, {
      method,
      signal: AbortSignal.timeout(path === "/login" ? 15 * 60_000 : 20_000),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Could not reach T3 Code's local authentication service (${detail}). Restart T3 Code and try again.`,
      { cause },
    );
  }
  const responseText = await response.text();
  let payload: CodexAuthStatus & { readonly error?: string };
  try {
    payload = responseText
      ? (JSON.parse(responseText) as CodexAuthStatus & { readonly error?: string })
      : { authenticated: false };
  } catch (cause) {
    throw new Error(
      `T3 Code's authentication service returned an invalid response (HTTP ${response.status}).`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(payload.error || `ChatGPT authentication failed (HTTP ${response.status}).`);
  }
  return payload;
}

const MODEL_APIS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly envName: string;
  readonly placeholder: string;
  readonly description: string;
  readonly Logo: Logo;
}> = [
  {
    id: "openai",
    name: "OpenAI",
    envName: "OPENAI_API_KEY",
    placeholder: "sk-...",
    description: "GPT models through the OpenAI API.",
    Logo: OpenAI,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envName: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-...",
    description: "Claude models through the Anthropic API.",
    Logo: ClaudeAI,
  },
  {
    id: "google",
    name: "Google",
    envName: "GEMINI_API_KEY",
    placeholder: "AIza...",
    description: "Gemini models through Google AI Studio.",
    Logo: Gemini,
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    envName: "OPENCODE_API_KEY",
    placeholder: "OpenCode Zen API key",
    description: "OpenCode Zen gateway models through T3 Code.",
    Logo: OpenCodeIcon,
  },
];

export function ModelsSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const clientSettingsHydrated = useClientSettingsHydrated();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus | null>(null);
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const [codexAuthError, setCodexAuthError] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const modelPreferencesRef = useRef(settings.providerModelPreferences);
  const [modelPreferences, setModelPreferences] = useState(settings.providerModelPreferences);

  const instance = settings.providerInstances[SPARKY_INSTANCE_ID];
  const variables = useMemo(
    () => new Map((instance?.environment ?? []).map((variable) => [variable.name, variable])),
    [instance?.environment],
  );
  const providerEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const searchableModels = useMemo(() => {
    const normalizedQuery = modelQuery.trim().toLowerCase();
    return providerEntries
      .flatMap((entry) => {
        const preferences = settings.providerModelPreferences[entry.instanceId] ?? {
          hiddenModels: [],
          modelOrder: [],
        };
        const inventorySettings = {
          ...settings,
          providerModelPreferences: {
            ...settings.providerModelPreferences,
            [entry.instanceId]: {
              ...preferences,
              hiddenModels: [],
            },
          },
        };
        return getAppModelOptionsForInstance(inventorySettings, entry).map((model) => ({
          entry,
          model,
        }));
      })
      .filter(({ entry, model }) =>
        normalizedQuery.length === 0
          ? true
          : `${model.slug} ${model.name} ${model.shortName ?? ""} ${model.subProvider ?? ""} ${entry.displayName}`
              .toLowerCase()
              .includes(normalizedQuery),
      );
  }, [modelQuery, providerEntries, settings]);

  useEffect(() => {
    if (!clientSettingsHydrated) return;
    modelPreferencesRef.current = settings.providerModelPreferences;
    setModelPreferences(settings.providerModelPreferences);
  }, [clientSettingsHydrated, settings.providerModelPreferences]);

  useEffect(() => {
    let active = true;
    void codexAuthRequest()
      .then((status) => {
        if (active) setCodexAuth(status);
      })
      .catch((error: unknown) => {
        if (active) setCodexAuthError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  const refreshSparkyProvider = async () => {
    if (!primaryEnvironment) {
      throw new Error("T3 Code's local provider is not connected yet. Restart T3 Code and try again.");
    }
    const result = await refreshServerProviders({
      environmentId: primaryEnvironment.environmentId,
      input: { instanceId: SPARKY_INSTANCE_ID },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error(String(error));
    }
  };

  const updateCodexAuthentication = async (operation: "login" | "logout") => {
    setCodexAuthBusy(true);
    setCodexAuthError(null);
    try {
      const status = await codexAuthRequest(`/${operation}`, "POST");
      setCodexAuth(status);
      await refreshSparkyProvider();
    } catch (error) {
      setCodexAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setCodexAuthBusy(false);
    }
  };

  const setModelEnabled = (instanceId: ProviderInstanceId, model: string, enabled: boolean) => {
    if (!clientSettingsHydrated) return;
    const currentPreferences = modelPreferencesRef.current;
    const existing = currentPreferences[instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    const hiddenModels = enabled
      ? existing.hiddenModels.filter((slug) => slug !== model)
      : [...new Set([...existing.hiddenModels, model])];
    const nextPreferences = {
      ...currentPreferences,
      [instanceId]: {
        ...existing,
        hiddenModels,
      },
    };

    modelPreferencesRef.current = nextPreferences;
    setModelPreferences(nextPreferences);
    updateSettings({ providerModelPreferences: nextPreferences });
  };

  const commitKey = (envName: string, value: string) => {
    const knownNames = new Set(MODEL_APIS.map((api) => api.envName));
    const existingVariables = (instance?.environment ?? []).filter(
      (variable) => !knownNames.has(variable.name) || variable.name !== envName,
    );
    const environment = [
      ...existingVariables,
      {
        name: envName,
        value,
        sensitive: true,
        ...(value.length === 0 ? {} : { valueRedacted: false }),
      },
    ];
    const nextInstance: ProviderInstanceConfig = {
      driver: SPARKY_DRIVER,
      displayName: "T3 Code",
      enabled: true,
      environment,
      config: instance?.config ?? { binaryPath: "" },
    };
    updateSettings({
      providerInstances: {
        ...settings.providerInstances,
        [SPARKY_INSTANCE_ID]: nextInstance,
      },
    });
    setDrafts((current) => ({ ...current, [envName]: "" }));
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Models" icon={<BoxesIcon className="size-3.5" />}>
        <div className="px-4 py-3">
          <label className="flex h-10 items-center gap-2.5 rounded-xl border border-border/70 bg-background/70 px-3 shadow-sm/4 transition-[border-color,box-shadow] duration-200 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground/65" aria-hidden />
            <input
              type="search"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder="Search models…"
              aria-label="Search models"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/45"
            />
          </label>
        </div>

        <div className="border-t border-border/50">
          {searchableModels.length === 0 ? (
            <div className="px-5 py-5 text-sm text-muted-foreground">
              {providerEntries.length === 0
                ? "No configured models found."
                : "No models match your search."}
            </div>
          ) : (
            searchableModels.map(({ entry, model }) => {
              const preferences = modelPreferences[entry.instanceId] ?? {
                hiddenModels: [],
                modelOrder: [],
              };
              const enabled = !preferences.hiddenModels.includes(model.slug);
              const providerPresentation = getModelProviderPresentation(model);
              const ModelProviderIcon = providerPresentation?.Icon ?? SparkyIcon;
              const modelDisplayName = getDisplayModelName(model, { preferShortName: true });
              const providerDisplayName = providerPresentation?.label ?? entry.displayName;
              return (
                <div
                  key={`${entry.instanceId}:${model.slug}`}
                  data-model-enabled={enabled ? "true" : "false"}
                  className="group flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3 last:border-b-0 hover:bg-muted/20"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/70"
                      title={providerDisplayName}
                    >
                      <ModelProviderIcon className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-foreground">
                        {modelDisplayName}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground/65">
                        {providerDisplayName}
                      </div>
                    </div>
                  </div>
                  <Switch
                    checked={enabled}
                    disabled={!clientSettingsHydrated}
                    className="shrink-0"
                    onCheckedChange={(checked) =>
                      setModelEnabled(entry.instanceId, model.slug, Boolean(checked))
                    }
                    aria-label={`${enabled ? "Disable" : "Enable"} ${modelDisplayName}`}
                  />
                </div>
              );
            })
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Provider configuration">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-[13px] font-semibold text-foreground [&::-webkit-details-marker]:hidden">
            <span>Model APIs and credentials</span>
            <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-border/60">
            {MODEL_APIS.map(({ id, name, envName, placeholder, description, Logo }) => {
              const stored = variables.get(envName);
              const configured = stored?.valueRedacted === true || Boolean(stored?.value);
              const draft = drafts[envName] ?? "";
              return (
                <div key={id} className="border-t border-border/60 px-5 py-4 first:border-t-0">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background/70 shadow-sm/4">
                        <Logo className="size-5" aria-hidden />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[13px] font-semibold text-foreground">{name}</h3>
                          {configured ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2Icon className="size-3" /> Configured
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
                          {description}
                        </p>
                        {id === "openai" ? (
                          <div className="mt-2">
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground disabled:opacity-50"
                              disabled={codexAuthBusy}
                              onClick={() =>
                                void updateCodexAuthentication(
                                  codexAuth?.authenticated ? "logout" : "login",
                                )
                              }
                            >
                              {codexAuthBusy ? (
                                <LoaderCircleIcon className="size-3 animate-spin" />
                              ) : codexAuth?.authenticated ? (
                                <CheckCircle2Icon className="size-3 text-emerald-500" />
                              ) : null}
                              {codexAuth?.authenticated
                                ? "Signed in with ChatGPT subscription"
                                : codexAuthBusy
                                  ? "Signing in to ChatGPT…"
                                  : "Already have a subscription? Sign in with ChatGPT"}
                            </button>
                            {codexAuthError ? (
                              <p role="alert" className="mt-1 text-xs text-destructive">
                                {codexAuthError}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex w-full min-w-0 flex-col gap-2 lg:max-w-md lg:flex-1">
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                          type="password"
                          value={draft}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={configured ? "Enter a replacement key" : placeholder}
                          aria-label={`${name} API key`}
                          onChange={(event) =>
                            setDrafts((current) => ({ ...current, [envName]: event.target.value }))
                          }
                          className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background/70 px-3 text-sm outline-none shadow-sm/4 transition-colors placeholder:text-muted-foreground/50 focus:border-ring focus:ring-2 focus:ring-ring/20"
                        />
                        <Button
                          type="button"
                          size="sm"
                          className="h-9 shrink-0 gap-1.5"
                          disabled={draft.trim().length === 0}
                          onClick={() => commitKey(envName, draft.trim())}
                        >
                          <SaveIcon className="size-3.5" /> Save key
                        </Button>
                        {configured ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-9 shrink-0 gap-1.5 text-destructive hover:text-destructive"
                            onClick={() => commitKey(envName, "")}
                          >
                            <Trash2Icon className="size-3.5" /> Remove
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
