// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
/**
 * ClaudeAgentDriver: the "Claude Code" provider. It runs Claude Code through the
 * Claude Agent SDK and is separate from Sparky's aggregated Claude API models.
 *
 * Two sign-in modes, neither of which handles a credential in Sparky:
 *   - `claudeAccount` (default): the user's own Claude Code is signed in with
 *     `claude auth login`, which runs Anthropic's own sign-in flow. Sparky detects
 *     that sign-in and the plan, then runs that same Claude Code.
 *   - `apiKey`: a Claude Console API key, read from this instance's environment or
 *     from Sparky's Models settings.
 * See `claudeAgent/ClaudeAgentOptions.ts` for the environment rules.
 *
 * @module provider/Drivers/ClaudeAgentDriver
 */
import {
  ProviderDriverKind,
  TextGenerationError,
  type ModelSelection,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ProviderWorkspaceContext,
  type ServerProvider,
  type ServerProviderModel,
} from "@sparky/contracts";
import { query as sdkQuery, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import {
  probeClaudeAccount,
  type ClaudeAccountStatus,
} from "../../claudeAgent/ClaudeAgentAccount.ts";
import {
  buildClaudeAgentOptions,
  resolveClaudeAgentApiKey,
  type ClaudeAgentAuthMode,
} from "../../claudeAgent/ClaudeAgentOptions.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { sanitizeThreadTitle } from "../../textGeneration/TextGenerationUtils.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeClaudeAgentAdapter } from "../Layers/ClaudeAgentAdapter.ts";
import { COMPUTER_USE_SKILL } from "./computerUseSkill.ts";

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
/** Sparky's own Anthropic key lives on the Sparky instance's Models settings. */
const SPARKY_DRIVER_KIND = "sparky";

/** Claude models offered by the Claude Code runtime. */
export const CLAUDE_CODE_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: null,
    isDefault: true,
  },
  { slug: "claude-opus-4-8", name: "Claude Opus 4.8", isCustom: false, capabilities: null },
  { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", isCustom: false, capabilities: null },
  { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", isCustom: false, capabilities: null },
];

const ClaudeAgentSettings = Schema.Struct({
  binaryPath: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** `claudeAccount` uses the user's own sign-in. `apiKey` uses a Console key. */
  authMode: Schema.Literals(["claudeAccount", "apiKey"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("claudeAccount" as const)),
  ),
});
type ClaudeAgentSettings = typeof ClaudeAgentSettings.Type;

/**
 * Find the Anthropic key. Order: this instance's environment (merged with the
 * process environment), then the Sparky instance's Models environment.
 */
export function findClaudeAgentApiKey(input: {
  readonly processEnvironment: NodeJS.ProcessEnv;
  readonly sparkyEnvironments: ReadonlyArray<ProviderInstanceEnvironment | undefined>;
}): string | undefined {
  const own = resolveClaudeAgentApiKey(input.processEnvironment);
  if (own.ok) return own.apiKey;
  for (const environment of input.sparkyEnvironments) {
    const value = environment?.find((variable) => variable.name === "ANTHROPIC_API_KEY")?.value;
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function makeClaudeAgentSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly continuationKey: string;
  readonly authMode: ClaudeAgentAuthMode;
  readonly hasApiKey: boolean;
  /** Result of the sign-in probe. Undefined while it is still running. */
  readonly account?: ClaudeAccountStatus | undefined;
}): ServerProvider {
  const base = {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    displayName: input.displayName,
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationKey },
    showInteractionModeToggle: true,
    requiresNewThreadForModelChange: false,
    enabled: input.enabled,
    installed: true,
    version: packageJson.version,
    checkedAt: new Date().toISOString(),
    availability: "available",
    models: CLAUDE_CODE_MODELS,
    slashCommands: [],
    skills: [],
  } as const;

  if (input.authMode === "apiKey") {
    const hasKey = input.hasApiKey;
    return {
      ...base,
      status: !input.enabled ? "disabled" : hasKey ? "ready" : "warning",
      auth: {
        status: hasKey ? "authenticated" : "unauthenticated",
        type: "apiKey",
        label: hasKey ? "Anthropic API key connected" : "Add an Anthropic API key",
      },
      ...(hasKey
        ? {}
        : {
            message:
              "Claude Code needs an Anthropic API key (ANTHROPIC_API_KEY) in Models settings, or switch to your Claude account.",
          }),
    } satisfies ServerProvider;
  }

  // claudeAccount: the user's own Claude Code sign-in and plan.
  const account = input.account;
  if (account === undefined) {
    return {
      ...base,
      status: !input.enabled ? "disabled" : "warning",
      auth: { status: "unknown", type: "oauth", label: "Checking Claude Code sign-in" },
      message: "Checking your Claude Code sign-in…",
    } satisfies ServerProvider;
  }
  if (!account.signedIn) {
    return {
      ...base,
      status: !input.enabled ? "disabled" : "warning",
      auth: { status: "unauthenticated", type: "oauth", label: "Sign in with Claude" },
      message: account.reason ?? "Claude Code is not signed in.",
    } satisfies ServerProvider;
  }
  const label = account.plan ? `Claude ${account.plan} subscription` : "Claude account";
  return {
    ...base,
    status: !input.enabled ? "disabled" : "ready",
    auth: {
      status: "authenticated",
      type: "oauth",
      label,
      ...(account.email ? { email: account.email } : {}),
    },
  } satisfies ServerProvider;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? value;
  try {
    const parsed = JSON.parse(fenced.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** One-shot, tool-free Claude Code call used for metadata generation. */
async function runClaudeTextGeneration(input: {
  readonly apiKey: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly model: string;
  readonly prompt: string;
  readonly systemPrompt?: string | undefined;
  readonly pathToClaudeCodeExecutable?: string | undefined;
}): Promise<string> {
  const abortController = new AbortController();
  const options = {
    ...buildClaudeAgentOptions({
      cwd: input.cwd,
      model: input.model,
      apiKey: input.apiKey,
      environment: input.environment,
      sparkyMcp: undefined,
      systemPromptAppend: input.systemPrompt ?? "",
      permissionMode: "default",
      resumeSessionId: undefined,
      abortController,
      canUseTool: async () => ({ behavior: "deny", message: "Text generation uses no tools." }),
      ...(input.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable }
        : {}),
    }),
    tools: [] as string[],
    maxTurns: 1,
  };
  const stream = sdkQuery({ prompt: input.prompt, options });
  let final: SDKResultMessage | undefined;
  for await (const message of stream) {
    if (message.type === "result") {
      final = message;
      break;
    }
  }
  if (!final) throw new Error("Claude Code returned no result.");
  if (final.subtype !== "success" || final.is_error) {
    throw new Error(`Claude Code text generation failed: ${final.subtype}`);
  }
  return final.result;
}

function makeClaudeAgentTextGeneration(input: {
  readonly authMode: ClaudeAgentAuthMode;
  readonly apiKey: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly pathToClaudeCodeExecutable: string | undefined;
}): TextGeneration.TextGeneration["Service"] {
  const run = (
    operation: string,
    cwd: string,
    modelSelection: ModelSelection,
    prompt: string,
    workspaceContext: ProviderWorkspaceContext = "project",
    systemPrompt?: string,
  ) =>
    Effect.tryPromise({
      try: () => {
        if (input.authMode === "apiKey" && !input.apiKey) {
          throw new Error("Add an Anthropic API key to use Claude Code.");
        }
        return runClaudeTextGeneration({
          apiKey: input.authMode === "apiKey" ? input.apiKey : undefined,
          environment: input.environment,
          cwd: workspaceContext === "none" ? process.cwd() : cwd,
          model: modelSelection.model,
          prompt,
          systemPrompt,
          pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
        });
      },
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(Effect.map((response) => ({ response })));

  return {
    generateCommitMessage: (request) =>
      run(
        "generateCommitMessage",
        request.cwd,
        request.modelSelection,
        `Return JSON only with subject, body${request.includeBranch ? ", and branch" : ""}.\nBranch: ${request.branch ?? "none"}\nSummary:\n${request.stagedSummary}\nPatch:\n${request.stagedPatch}`,
      ).pipe(
        Effect.map(({ response }) => {
          const parsed = parseJsonObject(response);
          const subject = typeof parsed?.subject === "string" ? parsed.subject : response.trim();
          const body = typeof parsed?.body === "string" ? parsed.body : "";
          const branch = typeof parsed?.branch === "string" ? parsed.branch : undefined;
          return { subject, body, ...(branch ? { branch } : {}) };
        }),
      ),
    generatePrContent: (request) =>
      run(
        "generatePrContent",
        request.cwd,
        request.modelSelection,
        `Return JSON only with title and body for this pull request.\nBase: ${request.baseBranch}\nHead: ${request.headBranch}\nCommits:\n${request.commitSummary}\nDiff:\n${request.diffSummary}\n${request.diffPatch}`,
      ).pipe(
        Effect.map(({ response }) => {
          const parsed = parseJsonObject(response);
          return {
            title: typeof parsed?.title === "string" ? parsed.title : "Sparky changes",
            body: typeof parsed?.body === "string" ? parsed.body : response,
          };
        }),
      ),
    generatePullRequestReview: (request) =>
      run(
        "generatePullRequestReview",
        request.cwd,
        request.modelSelection,
        request.prompt,
        "none",
        request.systemPrompt,
      ).pipe(Effect.map(({ response }) => ({ response }))),
    generateBranchName: (request) =>
      run(
        "generateBranchName",
        request.cwd,
        request.modelSelection,
        `Return only a short kebab-case git branch name for: ${request.message}`,
      ).pipe(
        Effect.map(({ response }) => ({
          branch: response.trim().split(/\s/u)[0] || "sparky-change",
        })),
      ),
    generateThreadTitle: (request) =>
      run(
        "generateThreadTitle",
        request.cwd,
        request.modelSelection,
        [
          "You are a conversation-title generator. Do not answer the user's request.",
          'Return JSON only in this exact shape: {"title":"..."}',
          "Use at most 4 short words, with no trailing period.",
          `User's first message:\n${request.message.trim()}`,
        ].join("\n"),
        request.workspaceContext,
      ).pipe(
        Effect.map(({ response }) => {
          const parsed = parseJsonObject(response);
          const rawTitle = typeof parsed?.title === "string" ? parsed.title : response;
          return { title: sanitizeThreadTitle(rawTitle) };
        }),
      ),
  };
}

export const ClaudeAgentDriver: ProviderDriver<
  ClaudeAgentSettings,
  ServerSettingsService | ServerConfig
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude Code",
    supportsMultipleInstances: false,
  },
  configSchema: ClaudeAgentSettings,
  defaultConfig: () => ({ binaryPath: "", authMode: "claudeAccount" }),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const processEnvironment = { ...mergeProviderInstanceEnvironment(environment) };
      const sparkyEnvironments = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) =>
          Object.values(settings.providerInstances ?? {})
            .filter((entry) => entry.driver === SPARKY_DRIVER_KIND)
            .map((entry) => entry.environment),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<ProviderInstanceEnvironment | undefined>),
      );
      const authMode: ClaudeAgentAuthMode = config.authMode;
      const apiKey = findClaudeAgentApiKey({ processEnvironment, sparkyEnvironments });
      // The user's own Claude Code binary, when they configured one. Otherwise the
      // SDK's bundled binary, which reads the same stored sign-in.
      const claudeBinary = config.binaryPath.trim() || undefined;
      const resolvedDisplayName = displayName ?? "Claude Code";
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      // In claudeAccount mode no key is put in the environment. The adapter
      // passes it only in apiKey mode.
      const runtimeEnvironment: NodeJS.ProcessEnv =
        authMode === "apiKey" && apiKey
          ? { ...processEnvironment, ANTHROPIC_API_KEY: apiKey }
          : processEnvironment;

      const snapshotInput = {
        instanceId,
        displayName: resolvedDisplayName,
        ...(accentColor ? { accentColor } : {}),
        enabled,
        continuationKey: continuationIdentity.continuationKey,
        authMode,
        hasApiKey: apiKey !== undefined,
      } as const;

      const snapshotRef = yield* Ref.make(makeClaudeAgentSnapshot(snapshotInput));
      const snapshotChanges = yield* PubSub.sliding<ServerProvider>(1);
      const refreshSnapshot = Effect.gen(function* () {
        // The probe reads the sign-in with no model request. Refresh re-runs it.
        const account =
          authMode === "claudeAccount"
            ? yield* Effect.promise(() =>
                probeClaudeAccount({
                  environment: runtimeEnvironment,
                  cwd: process.cwd(),
                  pathToClaudeCodeExecutable: claudeBinary,
                }),
              )
            : undefined;
        const snapshot = makeClaudeAgentSnapshot({ ...snapshotInput, account });
        yield* Ref.set(snapshotRef, snapshot);
        yield* PubSub.publish(snapshotChanges, snapshot);
        return snapshot;
      });
      // Check the sign-in in the background so the server starts without waiting.
      yield* refreshSnapshot.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        environment: runtimeEnvironment,
        attachmentsDir: serverConfig.attachmentsDir,
        authMode,
        pathToClaudeCodeExecutable: claudeBinary,
        getCustomInstructions: () =>
          serverSettings.getSettings.pipe(
            Effect.map((settings) => {
              const computerUse = settings.computerUse.enabled
                ? [COMPUTER_USE_SKILL, settings.computerUse.customInstructions.trim()]
                    .filter((part) => part.length > 0)
                    .join("\n\n")
                : "";
              return [settings.customInstructions.trim(), computerUse]
                .filter((part) => part.length > 0)
                .join("\n\n");
            }),
            Effect.orElseSucceed(() => ""),
          ),
      });

      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName: resolvedDisplayName,
        accentColor,
        enabled,
        snapshot: {
          maintenanceCapabilities,
          getSnapshot: Ref.get(snapshotRef),
          refresh: refreshSnapshot,
          subscribeChanges: PubSub.subscribe(snapshotChanges),
          streamChanges: Stream.fromPubSub(snapshotChanges),
        },
        adapter,
        textGeneration: makeClaudeAgentTextGeneration({
          authMode,
          apiKey,
          environment: runtimeEnvironment,
          pathToClaudeCodeExecutable: claudeBinary,
        }),
      } satisfies ProviderInstance;
    }),
};
