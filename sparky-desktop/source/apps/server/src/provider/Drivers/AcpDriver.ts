// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import { ProviderDriverKind, TextGenerationError, type ServerProvider } from "@sparky/contracts";
import { SpawnExecutableResolution } from "@sparky/shared/shell";
import { HostProcessPlatform } from "@sparky/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { defaultProviderContinuationIdentity } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { makeAcpAdapter } from "../Layers/AcpAdapter.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";

export function parseArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let tokenStarted = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) args.push(current);
      current = "";
      tokenStarted = false;
    } else {
      current += character;
      tokenStarted = true;
    }
  }

  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in ACP command arguments.");
  if (tokenStarted) args.push(current);
  return args;
}

function makeDriver(
  kind: string,
  name: string,
  defaultCommand: string,
  defaultArgs = "",
): ProviderDriver<
  {
    command: string;
    args: string;
  },
  ServerConfig
> {
  const driverKind = ProviderDriverKind.make(kind);
  const configSchema = Schema.Struct({
    command: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed(defaultCommand)),
    ).annotate({
      title: "ACP command",
      description: "Command that starts the harness in stdio ACP mode.",
      providerSettingsForm: { placeholder: "e.g. npx", clearWhenEmpty: "persist" },
    }),
    args: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(defaultArgs))).annotate({
      title: "Command arguments",
      description: "Optional arguments; quote values that contain spaces.",
      providerSettingsForm: {
        placeholder: "--yes @agentclientprotocol/codex-acp",
        clearWhenEmpty: "persist",
      },
    }),
  });
  return {
    driverKind,
    metadata: { displayName: name, supportsMultipleInstances: true },
    configSchema,
    defaultConfig: () => ({ command: defaultCommand, args: defaultArgs }),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const server = yield* ServerConfig;
        const env = mergeProviderInstanceEnvironment(environment);
        const resolve = yield* SpawnExecutableResolution;
        const platform = yield* HostProcessPlatform;
        const command = config.command.trim() || defaultCommand;
        const args = parseArgs(config.args);
        const installed = !!command && !!resolve(command, platform, env);
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind,
          instanceId,
        });
        const snapshot: ServerProvider = {
          instanceId,
          driver: driverKind,
          displayName: displayName ?? name,
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          requiresNewThreadForModelChange: true,
          showInteractionModeToggle: false,
          enabled,
          installed,
          version: null,
          availability: "available",
          status: !enabled ? "disabled" : installed ? "ready" : "warning",
          auth: {
            status: "unknown",
            type: "cli",
            label: "Uses the harness CLI login / subscription",
          },
          checkedAt: new Date().toISOString(),
          ...(!installed
            ? {
                message: `Install ${defaultCommand || "an ACP adapter"} locally and set its command in provider settings. Sign in using the harness CLI.`,
              }
            : {}),
          models: [
            {
              slug: "default",
              name: "Harness default",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        };
        const adapter = yield* makeAcpAdapter({
          instanceId,
          driver: driverKind,
          command,
          args,
          environment: env,
          stateDir: server.stateDir,
          attachmentsDir: server.attachmentsDir,
        });
        const unsupported = (operation: string) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail:
                "ACP harnesses run interactive chats only. Select Sparky for metadata generation.",
            }),
          );
        const textGeneration: TextGeneration.TextGeneration["Service"] = {
          generateThreadTitle: (request) =>
            Effect.succeed({
              title:
                request.message.trim().split(/\s/u).slice(0, 6).join(" ").slice(0, 80) ||
                "Harness chat",
            }),
          generateCommitMessage: () => unsupported("generateCommitMessage"),
          generatePrContent: () => unsupported("generatePrContent"),
          generateBranchName: () => unsupported("generateBranchName"),
          generatePullRequestReview: () => unsupported("generatePullRequestReview"),
        };
        return {
          instanceId,
          driverKind,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          adapter,
          textGeneration,
          snapshot: {
            getSnapshot: Effect.succeed(snapshot),
            refresh: Effect.succeed(snapshot),
            streamChanges: Stream.empty,
            maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
              provider: driverKind,
              packageName: null,
            }),
          },
        };
      }),
  };
}

export const CodexHarnessDriver = makeDriver(
  "codexHarness",
  "Codex CLI",
  "npx",
  "-y @agentclientprotocol/codex-acp",
);
export const ClaudeHarnessDriver = makeDriver(
  "claudeHarness",
  "Claude Code",
  "npx",
  "-y @agentclientprotocol/claude-agent-acp",
);
export const AcpDriver = makeDriver("acp", "ACP harness", "");
