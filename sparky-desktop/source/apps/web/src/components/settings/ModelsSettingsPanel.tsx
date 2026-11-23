import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import {
  BoxesIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  InfoIcon,
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
import { ClaudeAI, FireworksAI, Gemini, Ollama, OpenAI, SparkyIcon } from "../Icons";
import {
  CerebrasLogo,
  getDisplayModelName,
  getModelProviderPresentation,
  GroqLogo,
} from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { ClaudeCodeSettings } from "./ClaudeCodeSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

const SPARKY_INSTANCE_ID = ProviderInstanceId.make("sparky");
const SPARKY_DRIVER = ProviderDriverKind.make("sparky");
const CODEX_AUTH_PATH = "/api/sparky/codex-auth";
const CHATGPT_SECURITY_SETTINGS_URL = "https://chatgpt.com/#settings/Security";

type CodexAuthStatus = {
  readonly authenticated: boolean;
  readonly expires?: number | null;
  readonly planUsageAuthorized: boolean;
};

type CodexDeviceLogin = {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
};

type CodexDeviceLoginProgress = {
  readonly authenticated: boolean;
  readonly pending: boolean;
};

async function codexAuthRequest<T = CodexAuthStatus>(
  path = "",
  method = "GET",
  body?: unknown,
): Promise<T> {
  const requestUrl = resolvePrimaryEnvironmentHttpUrl(`${CODEX_AUTH_PATH}${path}`);
  let response: Response;
  try {
    response = await fetchPrimaryEnvironment(requestUrl, {
      method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      signal: AbortSignal.timeout(
        path === "/login" ? 65 * 60_000 : path.startsWith("/device/") ? 6 * 60_000 : 20_000,
      ),
    });
  } catch (cause) {
    if (path === "/login" && cause instanceof Error && cause.name === "TimeoutError") {
      throw new Error("ChatGPT sign-in timed out. Start sign-in again from Models settings.", { cause });
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Could not reach the local ChatGPT authentication service (${detail}). Restart the app and try again.`,
      { cause },
    );
  }
  const responseText = await response.text();
  let payload: CodexAuthStatus & { readonly error?: string };
  try {
    payload = responseText
      ? (JSON.parse(responseText) as CodexAuthStatus & { readonly error?: string })
      : { authenticated: false, planUsageAuthorized: false };
  } catch (cause) {
    throw new Error(
      `The local ChatGPT authentication service returned an invalid response (HTTP ${response.status}).`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(payload.error || `ChatGPT authentication failed (HTTP ${response.status}).`);
  }
  return payload as T;
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
    id: "fireworks",
    name: "Fireworks",
    envName: "FIREWORKS_API_KEY",
    placeholder: "fw_...",
    description: "OpenAI-compatible models through Fireworks AI.",
    Logo: FireworksAI,
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    envName: "OLLAMA_API_KEY",
    placeholder: "ollama_...",
    description: "Cloud-hosted Ollama models through ollama.com.",
    Logo: Ollama,
  },
  {
    id: "cerebras",
    name: "Cerebras",
    envName: "CEREBRAS_API_KEY",
    placeholder: "csk-...",
    description: "OpenAI-compatible models through Cerebras Inference.",
    Logo: CerebrasLogo,
  },
  {
    id: "groq",
    name: "Groq",
    envName: "GROQ_API_KEY",
    placeholder: "gsk_...",
    description: "OpenAI-compatible models through GroqCloud.",
    Logo: GroqLogo,
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
  const [deviceLogin, setDeviceLogin] = useState<CodexDeviceLogin | null>(null);
  const loginAttemptRef = useRef(0);
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

  useEffect(() => () => {
    // Invalidate the polling loop if the user leaves Models settings.
    loginAttemptRef.current += 1;
  }, []);

  const refreshSparkyProvider = async () => {
    if (!primaryEnvironment) {
      throw new Error("The local provider is not connected yet. Restart the app and try again.");
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

  const updateCodexAuthentication = async (operation: "login" | "browser" | "logout") => {
    const attempt = ++loginAttemptRef.current;
    setCodexAuthBusy(true);
    setCodexAuthError(null);
    setDeviceLogin(null);
    try {
      if (operation === "login") {
        // Device authorization polls OpenAI directly: it does not depend on
        // localhost:1455 or a browser tab remaining open after account selection.
        const device = await codexAuthRequest<CodexDeviceLogin>("/device/start", "POST");
        if (attempt !== loginAttemptRef.current) return;
        if (!device.deviceAuthId || !device.userCode || !device.verificationUri) {
          throw new Error("ChatGPT did not return a valid verification code.");
        }
        setDeviceLogin(device);
        try {
          if (typeof window.desktopBridge?.openExternal === "function") {
            // Launch the browser without blocking authorization polling on
            // Electron's external-shell promise or the browser tab lifetime.
            void window.desktopBridge.openExternal(device.verificationUri)
              .then((opened) => {
                if (!opened) window.open(device.verificationUri, "_blank", "noopener,noreferrer");
              })
              .catch(() => undefined);
          } else {
            window.open(device.verificationUri, "_blank", "noopener,noreferrer");
          }
        } catch {
          // The verification link remains visible for manual opening.
        }

        const intervalMs = Math.max(2, Math.min(device.intervalSeconds || 5, 30)) * 1_000;
        const deadline = Date.now() + Math.min(device.expiresInSeconds || 900, 900) * 1_000;
        while (Date.now() < deadline && attempt === loginAttemptRef.current) {
          await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
          if (attempt !== loginAttemptRef.current) return;
          const progress = await codexAuthRequest<CodexDeviceLoginProgress>(
            "/device/poll", "POST",
            { deviceAuthId: device.deviceAuthId, userCode: device.userCode },
          );
          if (progress.authenticated) {
            if (attempt !== loginAttemptRef.current) return;
            const status = await codexAuthRequest();
            if (!status.authenticated) throw new Error("ChatGPT sign-in was not saved.");
            setCodexAuth(status);
            await refreshSparkyProvider();
            return;
          }
          if (!progress.pending) throw new Error("ChatGPT declined the verification request.");
        }
        if (attempt === loginAttemptRef.current) {
          throw new Error("ChatGPT verification expired. Select Login with ChatGPT to try again.");
        }
      } else {
        const status = await codexAuthRequest(
          operation === "browser" ? "/login" : "/logout", "POST",
        );
        if (attempt !== loginAttemptRef.current) return;
        setCodexAuth(status);
        await refreshSparkyProvider();
      }
    } catch (error) {
      if (attempt === loginAttemptRef.current) {
        setCodexAuthError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (attempt === loginAttemptRef.current) {
        setDeviceLogin(null);
        setCodexAuthBusy(false);
      }
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

  const commitProviderKey = (api: (typeof MODEL_APIS)[number], keyValue: string) => {
    const providerKeyNames = new Set(MODEL_APIS.map((entry) => entry.envName));
    const legacyEndpointNames = new Set([
      "OPENAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "GEMINI_BASE_URL",
      "FIREWORKS_BASE_URL",
      "OLLAMA_CLOUD_BASE_URL",
    ]);
    const existingVariables = (instance?.environment ?? []).filter((variable) => {
      if (variable.name === api.envName) return false;
      if (api.id === "ollama-cloud" && variable.name === "OLLAMA_CLOUD_CONFIGURED") return false;
      return providerKeyNames.has(variable.name) || !legacyEndpointNames.has(variable.name);
    });
    const environment = [...existingVariables];
    if (keyValue.length > 0) {
      environment.push({
        name: api.envName,
        value: keyValue,
        sensitive: true,
        valueRedacted: false,
      });
      if (api.id === "ollama-cloud") {
        environment.push({ name: "OLLAMA_CLOUD_CONFIGURED", value: "true", sensitive: false });
      }
    }

    const nextInstance: ProviderInstanceConfig = {
      driver: SPARKY_DRIVER,
      displayName: "OpenAI",
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
    setDrafts((current) => ({ ...current, [api.envName]: "" }));
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
            {MODEL_APIS.map((api) => {
              const { id, name, envName, placeholder, description, Logo } = api;
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
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-50"
                                disabled={codexAuthBusy || codexAuth?.authenticated === true}
                                onClick={() => void updateCodexAuthentication("login")}
                              >
                                {codexAuthBusy ? (
                                  <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />
                                ) : codexAuth?.authenticated ? (
                                  <CheckCircle2Icon className="size-3 text-emerald-500" aria-hidden />
                                ) : null}
                                Login with ChatGPT
                              </button>
                              <Popover>
                                <PopoverTrigger
                                  render={
                                    <button
                                      type="button"
                                      aria-label="ChatGPT device-code sign-in requirements"
                                      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                    >
                                      <InfoIcon className="size-3.5" aria-hidden />
                                    </button>
                                  }
                                />
                                <PopoverPopup
                                  tooltipStyle
                                  side="top"
                                  align="start"
                                  className="w-64 max-w-[calc(100vw-2rem)]"
                                >
                                  <div className="space-y-1.5 p-2 text-xs leading-relaxed">
                                    <p>
                                      To log in, enable <strong>Device code sign-in</strong> in
                                      ChatGPT Settings → Security and login.
                                    </p>
                                    <p className="text-muted-foreground">
                                      Work account? Your workspace admin may need to enable it.
                                    </p>
                                    <a
                                      href={CHATGPT_SECURITY_SETTINGS_URL}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-block font-medium text-foreground underline underline-offset-2 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                    >
                                      Open ChatGPT security settings
                                    </a>
                                  </div>
                                </PopoverPopup>
                              </Popover>
                              {codexAuth?.authenticated ? (
                                <button
                                  type="button"
                                  className="text-xs text-muted-foreground/60 hover:text-foreground disabled:opacity-50"
                                  disabled={codexAuthBusy}
                                  onClick={() => void updateCodexAuthentication("logout")}
                                >
                                  Disconnect
                                </button>
                              ) : null}
                            </div>
                            {deviceLogin ? (
                              <div className="mt-2 text-xs text-muted-foreground">
                                Enter code <strong className="select-all font-semibold text-foreground">{deviceLogin.userCode}</strong> at{" "}
                                <a
                                  href={deviceLogin.verificationUri}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="underline underline-offset-2 hover:text-foreground"
                                >
                                  ChatGPT verification
                                </a>
                              </div>
                            ) : null}
                            {codexAuthError ? (
                              <div role="alert" className="mt-1 text-xs text-destructive">
                                {codexAuthError}
                                {!codexAuth?.authenticated ? (
                                  <button
                                    type="button"
                                    className="ml-2 underline underline-offset-2"
                                    disabled={codexAuthBusy}
                                    onClick={() => void updateCodexAuthentication("browser")}
                                  >
                                    Try browser login
                                  </button>
                                ) : null}
                              </div>
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
                          onClick={() => commitProviderKey(api, draft.trim())}
                        >
                          <SaveIcon className="size-3.5" /> Save key
                        </Button>
                        {configured ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-9 shrink-0 gap-1.5 text-destructive hover:text-destructive"
                            onClick={() => commitProviderKey(api, "")}
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
      <ClaudeCodeSettings />
    </SettingsPageContainer>
  );
}
