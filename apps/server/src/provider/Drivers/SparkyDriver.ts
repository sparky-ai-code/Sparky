// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import * as NodeFS from "node:fs";

import {
  ProviderDriverKind,
  TextGenerationError,
  type ProviderInstanceId,
  type ProviderWorkspaceContext,
  type ModelSelection,
  type ServerProvider,
} from "@sparky/contracts";
import { getModelSelectionStringOptionValue } from "@sparky/shared/model";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { sanitizeThreadTitle } from "../../textGeneration/TextGenerationUtils.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  makeSparkyAdapter,
  resolveSparkyRuntimeContextWindow,
  runSparkyTextGeneration,
} from "../Layers/SparkyAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { discoverSparkyModels, type SparkyModelDiscovery } from "./SparkyModelCatalog.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerConfig } from "../../config.ts";
import packageJson from "../../../package.json" with { type: "json" };

const DRIVER_KIND = ProviderDriverKind.make("sparky");
const SPARKY_PLUGIN_INSTRUCTIONS = `Sparky Desktop can expose connected service plugins through the sparky_plugin_call MCP tool. Only use a plugin when the user's current request actually requires that service. An @plugin reference is context, not permission to perform unrelated actions. If the user explicitly asks for a supported service and it is not connected, call sparky_request_plugin_authorization with that plugin id and wait for the user's authorization card. If the user cancels or declines, treat that as a normal non-fatal outcome and continue the conversation without repeatedly asking. Never ask the user for OAuth tokens, passwords, provider client secrets, or other credentials in chat.`;

const SparkySettings = Schema.Struct({
  binaryPath: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
type SparkySettings = typeof SparkySettings.Type;

function makeSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly continuationKey: string;
  readonly enabled: boolean;
  readonly binaryInstalled: boolean;
  readonly binaryPath: string;
  readonly discovery: SparkyModelDiscovery;
}): ServerProvider {
  const { discovery } = input;
  const hasModels = discovery.models.length > 0;
  const hasDiscoveryErrors = discovery.errors.length > 0;
  const message = !input.binaryInstalled
    ? `Sparky runtime was not found at ${input.binaryPath}.`
    : discovery.configuredProviderCount === 0
      ? "Add an OpenAI, Anthropic, or Google API key in Models."
      : hasDiscoveryErrors
        ? `Model refresh failed for ${discovery.errors.join("; ")}. Check the API key and your connection.`
        : !hasModels
          ? "The configured providers returned no compatible models."
          : undefined;

  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    displayName: input.displayName,
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationKey },
    showInteractionModeToggle: true,
    requiresNewThreadForModelChange: false,
    enabled: input.enabled,
    installed: input.binaryInstalled,
    version: packageJson.version,
    status: !input.enabled
      ? "disabled"
      : !input.binaryInstalled
        ? "error"
        : hasModels
          ? "ready"
          : "warning",
    auth: {
      status: hasModels ? "authenticated" : "unauthenticated",
      type: "apiKey",
      label: hasModels ? "Provider API keys connected" : "Add or verify an API key in Models",
    },
    checkedAt: new Date().toISOString(),
    availability: "available",
    ...(message ? { message } : {}),
    models: discovery.models,
    slashCommands: [
      {
        name: "compact",
        description: "Compact the current Sparky context",
      },
    ],
    skills: [],
  };
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

export function resolveSparkyTextGenerationRuntimeOptions(input: {
  readonly modelSelection: ModelSelection;
  readonly environment: NodeJS.ProcessEnv;
}): {
  readonly reasoningEffort?: string | undefined;
  readonly contextWindow?: string | undefined;
} {
  const { modelSelection, environment } = input;
  const reasoningEffort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  const contextWindow = resolveSparkyRuntimeContextWindow(
    modelSelection.model,
    modelSelection,
    environment,
  );
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

export function makeSparkyThreadTitlePrompt(message: string): string {
  return [
    "You are a dedicated conversation-title generator running in a separate metadata request.",
    "Do not answer the user's request and do not continue the conversation.",
    "Create a concise, specific title that captures the topic or requested outcome.",
    "Do not copy the user's wording verbatim, do not return a question, and do not use markdown.",
    'Return JSON only in this exact shape: {"title":"..."}',
    "Use at most 4 short words or 3 long words, with no trailing period.",
    `User's first message:\n${message.trim()}`,
  ].join("\n");
}

function makeTextGeneration(input: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}): TextGeneration.TextGeneration["Service"] {
  const run = (
    operation: string,
    cwd: string,
    modelSelection: ModelSelection,
    prompt: string,
    workspaceContext: ProviderWorkspaceContext = "project",
  ) =>
    runSparkyTextGeneration({
      binaryPath: input.binaryPath,
      cwd,
      prompt,
      model: modelSelection.model,
      ...(workspaceContext === "none" ? { workspaceContext } : {}),
      ...resolveSparkyTextGenerationRuntimeOptions({
        modelSelection,
        environment: input.environment,
      }),
      environment: input.environment,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: cause.message,
            cause,
          }),
      ),
    );

  return {
    generateCommitMessage: (request) =>
      run(
        "generateCommitMessage",
        request.cwd,
        request.modelSelection,
        `Return JSON only with subject, body${request.includeBranch ? ", and branch" : ""}.\nBranch: ${request.branch ?? "none"}\nSummary:\n${request.stagedSummary}\nPatch:\n${request.stagedPatch}`,
      ).pipe(
        Effect.map((result) => {
          const parsed = parseJsonObject(result.response);
          const subject =
            typeof parsed?.subject === "string" ? parsed.subject : result.response.trim();
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
        Effect.map((result) => {
          const parsed = parseJsonObject(result.response);
          return {
            title: typeof parsed?.title === "string" ? parsed.title : "Sparky changes",
            body: typeof parsed?.body === "string" ? parsed.body : result.response,
          };
        }),
      ),
    generateBranchName: (request) =>
      run(
        "generateBranchName",
        request.cwd,
        request.modelSelection,
        `Return only a short kebab-case git branch name for: ${request.message}`,
      ).pipe(
        Effect.map((result) => ({
          branch: result.response.trim().split(/\s/u)[0] || "sparky-change",
        })),
      ),
    generateThreadTitle: (request) =>
      run(
        "generateThreadTitle",
        request.cwd,
        request.modelSelection,
        makeSparkyThreadTitlePrompt(request.message),
        request.workspaceContext,
      ).pipe(
        Effect.map((result) => {
          const parsed = parseJsonObject(result.response);
          const rawTitle = typeof parsed?.title === "string" ? parsed.title : result.response;
          return { title: sanitizeThreadTitle(rawTitle) };
        }),
      ),
  };
}

export const SparkyDriver: ProviderDriver<
  SparkySettings,
  ServerSettingsService | ServerConfig | ProviderEventLoggers
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Sparky",
    supportsMultipleInstances: false,
  },
  configSchema: SparkySettings,
  defaultConfig: () => ({ binaryPath: "" }),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const binaryPath =
        config.binaryPath.trim() || processEnvironment.SPARKY_BINARY_PATH?.trim() || "sparky";
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const binaryInstalled =
        !binaryPath.includes("/") && !binaryPath.includes("\\")
          ? true
          : NodeFS.existsSync(binaryPath);
      const loadSnapshot = Effect.promise(() => discoverSparkyModels(processEnvironment)).pipe(
        Effect.map((discovery) =>
          makeSnapshot({
            instanceId,
            displayName: displayName ?? "Sparky",
            ...(accentColor ? { accentColor } : {}),
            continuationKey: continuationIdentity.continuationKey,
            enabled,
            binaryInstalled,
            binaryPath,
            discovery,
          }),
        ),
      );
      const snapshotValue = yield* loadSnapshot;
      const snapshotRef = yield* Ref.make(snapshotValue);
      const snapshotChanges = yield* PubSub.sliding<ServerProvider>(1);
      const refreshSnapshot = Effect.gen(function* () {
        const snapshot = yield* loadSnapshot;
        yield* Ref.set(snapshotRef, snapshot);
        yield* PubSub.publish(snapshotChanges, snapshot);
        return snapshot;
      });
      const adapter = yield* makeSparkyAdapter({
        instanceId,
        binaryPath,
        attachmentsDir: serverConfig.attachmentsDir,
        environment: processEnvironment,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        getCustomInstructions: () =>
          serverSettings.getSettings.pipe(
            Effect.map((settings) => {
              const personalityInstructions: Record<string, string> = {
                coding:
                  "Be direct and efficient. Focus on writing robust, production-quality code. Explain technical tradeoffs clearly. Prioritize correctness and maintainability. Keep responses concise.",
                everyday:
                  "Be warm and approachable. Explain concepts thoroughly as if teaching a peer. Encourage questions and collaboration. Take time to explore ideas together. Be patient and supportive.",
              };
              const personality =
                (settings as Record<string, unknown>).sparkyPersonality ?? "coding";
              const personalityPrompt = personalityInstructions[personality as string] ?? "";
              const custom = settings.customInstructions.trim();
              return [personalityPrompt, custom, SPARKY_PLUGIN_INSTRUCTIONS]
                .filter((instructions) => instructions.length > 0)
                .join("\n\n");
            }),
            Effect.orElseSucceed(() => SPARKY_PLUGIN_INSTRUCTIONS),
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
        displayName,
        accentColor,
        enabled,
        snapshot: {
          maintenanceCapabilities,
          getSnapshot: Ref.get(snapshotRef),
          refresh: refreshSnapshot,
          streamChanges: Stream.fromPubSub(snapshotChanges),
        },
        adapter,
        textGeneration: makeTextGeneration({ binaryPath, environment: processEnvironment }),
      } satisfies ProviderInstance;
    }),
};
