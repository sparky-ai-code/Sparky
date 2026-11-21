// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off
/**
 * ClaudeAgentDriver: the "Claude Code" provider. Sparky is an ACP client, and the
 * Claude ACP adapter runs the unmodified Claude Code harness. The adapter command is
 * configurable, so a user can point it at their own install.
 *
 * Sign-in belongs to Claude Code. The user runs `claude` and `/login` on their
 * machine, or sets an API key in this instance's environment. Sparky reads, stores,
 * and forwards no credential.
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
import type { SessionNotification } from "@agentclientprotocol/sdk";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import { buildClaudeAcpEnvironment } from "../../claudeAcp/ClaudeAcpEnvironment.ts";
import {
  ClaudeAcpProcess,
  probeClaudeAcp,
  type ClaudeAcpProbe,
} from "../../claudeAcp/ClaudeAcpProcess.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { sanitizeThreadTitle } from "../../textGeneration/TextGenerationUtils.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeClaudeAgentAdapter } from "../Layers/ClaudeAgentAdapter.ts";
import { COMPUTER_USE_SKILL } from "./computerUseSkill.ts";

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
export const DEFAULT_CLAUDE_ACP_COMMAND = "claude-agent-acp";

/** Claude models offered by the Claude Code runtime. ACP session options may refine this. */
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
  /** The ACP adapter executable. Set a full path to use a specific install. */
  command: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CLAUDE_ACP_COMMAND)),
  ),
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
type ClaudeAgentSettings = typeof ClaudeAgentSettings.Type;

/** Command the instance runs. An empty value falls back to the default adapter. */
export function resolveClaudeAcpCommand(command: string | undefined): string {
  const trimmed = command?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : DEFAULT_CLAUDE_ACP_COMMAND;
}

export function makeClaudeAgentSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly continuationKey: string;
  /** Result of the adapter probe. Undefined while it is still running. */
  readonly probe?: ClaudeAcpProbe | undefined;
  readonly command: string;
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
    version: packageJson.version,
    checkedAt: new Date().toISOString(),
    availability: "available",
    models: CLAUDE_CODE_MODELS,
    slashCommands: [],
    skills: [],
  } as const;

  if (!input.enabled) {
    return {
      ...base,
      status: "disabled",
      installed: false,
      auth: { status: "unknown", type: "oauth", label: "Claude Code" },
    } satisfies ServerProvider;
  }
  if (input.probe === undefined) {
    return {
      ...base,
      status: "warning",
      installed: false,
      auth: { status: "unknown", type: "oauth", label: "Checking Claude Code" },
      message: "Checking the Claude ACP adapter…",
    } satisfies ServerProvider;
  }
  if (!input.probe.ok) {
    return {
      ...base,
      status: "error",
      installed: false,
      auth: { status: "unknown", type: "oauth", label: "Claude Code" },
      message: input.probe.reason,
    } satisfies ServerProvider;
  }
  // The adapter runs. Sign-in is checked by Claude Code when a turn starts, so this
  // status does not claim the account is signed in.
  return {
    ...base,
    status: "ready",
    installed: true,
    auth: {
      status: "unknown",
      type: "oauth",
      label: "Signed in through Claude Code",
    },
    message:
      "Sign in by running `claude` in a terminal and using /login, or set ANTHROPIC_API_KEY in this provider's environment.",
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

/**
 * One-shot, tool-free call for metadata generation. It runs a fresh ACP session and
 * collects the assistant's text. The adapter starts with no MCP servers, and no
 * Sparky tools are granted.
 */
async function runClaudeAcpTextGeneration(input: {
  readonly command: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly prompt: string;
}): Promise<string> {
  let text = "";
  const proc = await ClaudeAcpProcess.start(
    { command: input.command, args: [], cwd: input.cwd, env: input.environment },
    {
      onUpdate: (notification: SessionNotification) => {
        const update = notification.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          text += update.content.text;
        }
      },
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    },
  );
  try {
    await proc.initialize();
    const session = await proc.newSession({ cwd: input.cwd, mcpServers: [] });
    const response = await proc.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: input.prompt }],
    });
    if (response.stopReason !== "end_turn") {
      throw new Error(`Claude Code text generation stopped: ${response.stopReason}`);
    }
    return text;
  } finally {
    proc.close();
  }
}

function makeClaudeAgentTextGeneration(input: {
  readonly command: string;
  readonly environment: Readonly<Record<string, string>>;
}): TextGeneration.TextGeneration["Service"] {
  const run = (
    operation: string,
    cwd: string,
    _modelSelection: ModelSelection,
    prompt: string,
    workspaceContext: ProviderWorkspaceContext = "project",
    systemPrompt?: string,
  ) =>
    Effect.tryPromise({
      try: () =>
        runClaudeAcpTextGeneration({
          command: input.command,
          environment: input.environment,
          cwd: workspaceContext === "none" ? process.cwd() : cwd,
          prompt: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
        }),
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
  defaultConfig: () => ({ command: DEFAULT_CLAUDE_ACP_COMMAND, args: [] }),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const command = resolveClaudeAcpCommand(config.command);
      const args = [...config.args];
      const resolvedDisplayName = displayName ?? "Claude Code";
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const instanceOverrides = (environment ?? []).map((variable) => ({
        name: variable.name,
        value: variable.value,
      }));
      const launchEnvironment = buildClaudeAcpEnvironment({
        ambient: process.env,
        instanceOverrides,
      });

      const snapshotInput = {
        instanceId,
        displayName: resolvedDisplayName,
        ...(accentColor ? { accentColor } : {}),
        enabled,
        continuationKey: continuationIdentity.continuationKey,
        command,
      } as const;

      const snapshotRef = yield* Ref.make(makeClaudeAgentSnapshot(snapshotInput));
      const snapshotChanges = yield* PubSub.sliding<ServerProvider>(1);
      const refreshSnapshot = Effect.gen(function* () {
        // The probe starts the adapter and runs `initialize`. It sends no model
        // request and reads no credential.
        const probe = enabled
          ? yield* Effect.promise(() =>
              probeClaudeAcp({
                launch: { command, args, cwd: process.cwd(), env: launchEnvironment },
              }),
            )
          : undefined;
        const snapshot = makeClaudeAgentSnapshot({ ...snapshotInput, probe });
        yield* Ref.set(snapshotRef, snapshot);
        yield* PubSub.publish(snapshotChanges, snapshot);
        return snapshot;
      });
      // Probe in the background so server startup does not wait on the adapter.
      yield* refreshSnapshot.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

      const adapter = yield* makeClaudeAgentAdapter({
        instanceId,
        command,
        args,
        instanceEnvironment: instanceOverrides,
        attachmentsDir: serverConfig.attachmentsDir,
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
          command,
          environment: launchEnvironment,
        }),
      } satisfies ProviderInstance;
    }),
};
