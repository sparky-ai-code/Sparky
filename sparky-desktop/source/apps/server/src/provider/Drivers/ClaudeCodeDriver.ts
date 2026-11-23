// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  ClaudeSettings,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { sanitizeThreadTitle } from "../../textGeneration/TextGenerationUtils.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  CLAUDE_CODE_DRIVER,
  CLAUDE_NO_WORKSPACE_ARGS,
  makeClaudeCodeAdapter,
} from "../Layers/ClaudeCodeAdapter.ts";
import {
  asClaudeJson,
  claudeResultError,
  resolveClaudeExecutablePath,
  loadClaudeInput,
  parseClaudeLaunchArgs,
  probeClaude,
  runClaudeProcess,
  type ClaudeExecutable,
} from "../Layers/claudeCodeProcess.ts";

const configSchema = Schema.Struct({
  binaryPath: ClaudeSettings.fields.binaryPath,
  homePath: ClaudeSettings.fields.homePath,
  customModels: ClaudeSettings.fields.customModels,
  launchArgs: ClaudeSettings.fields.launchArgs,
});

export const CLAUDE_CODE_STOCK_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "sonnet", name: "Claude Sonnet", isCustom: false, isDefault: true, capabilities: null },
  { slug: "opus", name: "Claude Opus", isCustom: false, capabilities: null },
  { slug: "haiku", name: "Claude Haiku", isCustom: false, capabilities: null },
  { slug: "fable", name: "Claude Fable", isCustom: false, capabilities: null },
];

function pathSetting(value: string): string {
  return /^~[/\\]/u.test(value) ? resolve(homedir(), value.slice(2)) : value;
}

function parseObject(text: string) {
  return asClaudeJson(JSON.parse(text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? text)) ?? {};
}

function makeTextGeneration(executable: ClaudeExecutable, cwd: string, attachmentsDir: string): TextGeneration["Service"] {
  const generate = <A>(
    operation: string,
    options: { modelSelection: { model: string }; attachments?: Parameters<typeof loadClaudeInput>[1] | undefined },
    prompt: string,
    decode: (text: string) => A,
    systemPrompt?: string,
  ) => Effect.tryPromise({
    try: async (signal) => {
      const content = await loadClaudeInput(prompt, options.attachments ?? [], attachmentsDir);
      const result = await runClaudeProcess({
        ...executable,
        cwd,
        signal,
        content,
        args: [
          ...CLAUDE_NO_WORKSPACE_ARGS,
          "--no-session-persistence", "--max-turns", "1",
          "--model", options.modelSelection.model,
          ...(systemPrompt ? ["--system-prompt", systemPrompt] : []),
        ],
      });
      const error = claudeResultError(result);
      if (error) throw new Error(error);
      if (typeof result.result !== "string" || !result.result.trim()) throw new Error("Claude Code returned no text.");
      return decode(result.result.trim());
    },
    catch: (cause) => new TextGenerationError({ operation, detail: String(cause), cause }),
  });
  return {
    generateCommitMessage: (request) => generate("generateCommitMessage", request,
      `Return JSON only with subject, body${request.includeBranch ? ", and branch" : ""}.\nBranch: ${request.branch ?? "none"}\nSummary:\n${request.stagedSummary}\nPatch:\n${request.stagedPatch}`,
      (text) => {
        const result = parseObject(text);
        return {
          subject: typeof result.subject === "string" ? result.subject : text,
          body: typeof result.body === "string" ? result.body : "",
          ...(typeof result.branch === "string" ? { branch: result.branch } : {}),
        };
      }),
    generatePrContent: (request) => generate("generatePrContent", request,
      `Return JSON only with title and body for this pull request.\nBase: ${request.baseBranch}\nHead: ${request.headBranch}\nCommits: ${request.commitSummary}\nDiff:\n${request.diffSummary}\n${request.diffPatch}`,
      (text) => {
        const result = parseObject(text);
        return { title: typeof result.title === "string" ? result.title : "Sparky changes", body: typeof result.body === "string" ? result.body : text };
      }),
    generatePullRequestReview: (request) => generate("generatePullRequestReview", request, request.prompt, (response) => ({ response }), request.systemPrompt),
    generateBranchName: (request) => generate("generateBranchName", request,
      `Return only a short kebab-case git branch name for the following task:\n${request.message}`,
      (text) => ({ branch: text })),
    generateThreadTitle: (request) => generate("generateThreadTitle", request,
      `Write only a concise title (at most four words) for the following first message. Do not answer the message.\n${request.message}`,
      (text) => ({ title: sanitizeThreadTitle(text) })),
  };
}

export const ClaudeCodeDriver: ProviderDriver<typeof configSchema.Type, ServerConfig> = {
  driverKind: CLAUDE_CODE_DRIVER,
  metadata: { displayName: "Claude Code", supportsMultipleInstances: false },
  configSchema,
  defaultConfig: () => ({ binaryPath: "claude", homePath: "", customModels: [], launchArgs: "" }),
  create: (input) => Effect.gen(function* () {
    if (input.instanceId !== "claudeAgent") {
      return yield* new ProviderDriverError({
        driver: CLAUDE_CODE_DRIVER,
        instanceId: input.instanceId,
        detail: "Configure the built-in Claude Code instance in Models settings.",
      });
    }
    const server = yield* ServerConfig;
    const launchArgs = yield* Effect.try({
      try: () => parseClaudeLaunchArgs(input.config.launchArgs),
      catch: (error) => new ProviderDriverError({
        driver: CLAUDE_CODE_DRIVER,
        instanceId: input.instanceId,
        detail: error instanceof Error ? error.message : String(error),
      }),
    });
    const environment = { ...mergeProviderInstanceEnvironment(input.environment) };
    // Do not inherit a parent Claude Code session or its team control socket.
    for (const key of Object.keys(environment)) {
      if (key === "CLAUDECODE" || key === "CLAUDE_CODE_ENTRYPOINT" || key.startsWith("CLAUDE_CODE_TEAM_") || key.startsWith("CLAUDE_CODE_SESSION_")) {
        delete environment[key];
      }
    }
    if (input.config.homePath) environment.CLAUDE_CONFIG_DIR = resolve(server.cwd, pathSetting(input.config.homePath));
    const configuredBinary = pathSetting(input.config.binaryPath.trim() || "claude");
    const detectedBinary = resolveClaudeExecutablePath(configuredBinary, environment);
    const binaryPath = detectedBinary ?? (isAbsolute(configuredBinary) || !/[/\\]/u.test(configuredBinary)
      ? configuredBinary : resolve(server.cwd, configuredBinary));
    const executable = { binaryPath, environment };
    const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: CLAUDE_CODE_DRIVER, instanceId: input.instanceId });
    const models = [...CLAUDE_CODE_STOCK_MODELS];
    for (const configuredModel of input.config.customModels) {
      const slug = configuredModel.trim();
      if (!slug || models.some((model) => model.slug === slug)) continue;
      models.push({ slug, name: slug, isCustom: true, capabilities: null });
    }
    const loadSnapshot = Effect.promise(async (signal): Promise<ServerProvider> => {
      // A version probe is read-only and lets the setup flow detect a disabled CLI before enabling it.
      const version = await probeClaude(executable, ["--version"], server.cwd, signal);
      const installed = version?.ok === true;
      const authProbe = input.enabled && installed ? await probeClaude(executable, ["auth", "status", "--json"], server.cwd, signal) : undefined;
      let auth: ServerProvider["auth"] = { status: "unknown" };
      if (authProbe?.stdout.trim()) {
        try {
          const status = parseObject(authProbe.stdout);
          if (typeof status.loggedIn === "boolean") {
            auth = { status: status.loggedIn ? "authenticated" : "unauthenticated" };
          }
        } catch {
          // Some CLI versions do not expose auth status as JSON. The turn still uses CLI auth.
        }
      }
      const message = !input.enabled ? undefined
        : !installed ? "Install Claude Code on this environment, or set its executable path."
        : auth.status === "unauthenticated" ? "Run `claude auth login` on this environment and refresh." : undefined;
      return {
        instanceId: input.instanceId,
        driver: CLAUDE_CODE_DRIVER,
        displayName: input.displayName ?? "Claude Code",
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        showInteractionModeToggle: true,
        enabled: input.enabled,
        installed,
        version: version?.stdout.trim() || null,
        status: !input.enabled ? "disabled" : !installed ? "error" : auth.status === "unauthenticated" ? "warning" : "ready",
        auth,
        checkedAt: new Date().toISOString(),
        executablePath: installed ? binaryPath : undefined,
        availability: "available",
        ...(message ? { message } : {}),
        models: installed ? models.map((model) => ({ ...model, subProvider: "Claude Code" })) : [],
        slashCommands: [],
        skills: [],
      };
    });
    const snapshot = yield* Ref.make(yield* loadSnapshot);
    const changes = yield* PubSub.unbounded<ServerProvider>();
    const refresh = loadSnapshot.pipe(Effect.tap((next) => Ref.set(snapshot, next).pipe(Effect.andThen(PubSub.publish(changes, next)))));
    const adapter = yield* makeClaudeCodeAdapter({
      ...executable,
      instanceId: input.instanceId,
      attachmentsDir: server.attachmentsDir,
      privateWorkspaceDir: resolve(server.stateDir, "claude-code-chats"),
      launchArgs,
    });
    return {
      instanceId: input.instanceId,
      driverKind: CLAUDE_CODE_DRIVER,
      displayName: input.displayName,
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuationIdentity,
      enabled: input.enabled,
      adapter,
      textGeneration: makeTextGeneration(executable, server.stateDir, server.attachmentsDir),
      snapshot: {
        getSnapshot: Ref.get(snapshot),
        refresh,
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes),
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: CLAUDE_CODE_DRIVER,
          packageName: null,
        }),
      },
    };
  }),
};
