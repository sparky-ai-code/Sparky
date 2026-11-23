import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { ClaudeSettings, ProviderInstanceId } from "@sparky/contracts";
import * as Schema from "effect/Schema";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI } from "../Icons";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const instanceId = ProviderInstanceId.make("claudeAgent");
const decodeConfig = Schema.decodeUnknownSync(ClaudeSettings);

export function ClaudeCodeSettings() {
  const settings = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const environment = usePrimaryEnvironment();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  const explicit = settings.providerInstances[instanceId];
  const legacy = settings.providers.claudeAgent;
  let config = legacy;
  if (explicit) {
    try {
      config = decodeConfig(explicit.config ?? {});
    } catch {
      // Saving a field below can repair a malformed provider config.
    }
  }
  const enabled = explicit ? explicit.enabled ?? true : legacy.enabled;
  const save = (patch: Partial<Pick<typeof config, "enabled" | "binaryPath" | "homePath" | "customModels" | "launchArgs">>) => {
    if (!explicit) {
      update({ providers: { ...settings.providers, claudeAgent: { ...legacy, ...patch } } });
      return;
    }
    const { enabled, ...configPatch } = patch;
    update({ providerInstances: {
      ...settings.providerInstances,
      [instanceId]: {
        ...explicit,
        ...(enabled !== undefined ? { enabled } : {}),
        config: { ...config, ...configPatch },
      },
    } });
  };
  const refresh = async () => {
    if (!environment) return;
    setRefreshing(true);
    setRefreshError(false);
    try {
      const result = await refreshProviders({ environmentId: environment.environmentId, input: { instanceId } });
      setRefreshError(result._tag === "Failure");
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <SettingsSection title="Claude Code" icon={<ClaudeAI className="size-3.5" />}>
      <SettingsRow
        title="Claude Code CLI"
        description={<>Use the native Claude Code CLI and its own login, separate from the Anthropic API key. <a className="underline" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">Install Claude Code</a> on the machine running the Sparky backend.</>}
        status={refreshError ? "Could not refresh Claude Code status." : !enabled ? "Disabled" : snapshot?.message ?? (snapshot?.installed ? snapshot.version ?? "Installed" : "Waiting for provider status…")}
        control={<>
          <Button variant="outline" size="sm" disabled={!environment || !enabled || refreshing} onClick={() => void refresh()}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <Switch checked={enabled} disabled={!environment} onCheckedChange={(next) => save({ enabled: next })} aria-label="Enable Claude Code" />
        </>}
      />
      <SettingsRow title="Executable" description="Leave blank to find claude on the backend's PATH. On Windows, use the native claude.exe.">
        <DraftInput className="mb-4 mt-3" aria-label="Claude Code executable" placeholder="claude" value={config.binaryPath === "claude" ? "" : config.binaryPath} onCommit={(value) => save({ binaryPath: value.trim() || "claude" })} />
      </SettingsRow>
      <SettingsRow title="Config directory" description="Optional CLAUDE_CONFIG_DIR for CLI settings, login and conversation history. Keep it unchanged to resume existing Claude Code chats.">
        <DraftInput className="mb-4 mt-3" aria-label="Claude Code config directory" placeholder="~/.claude" value={config.homePath} onCommit={(value) => save({ homePath: value.trim() })} />
      </SettingsRow>
      <SettingsRow title="Launch arguments" description="Additional Claude Code CLI arguments, parsed without a shell. Keep arguments compatible with stream-json sessions.">
        <DraftInput className="mb-4 mt-3" aria-label="Claude Code launch arguments" placeholder="e.g. --chrome" value={config.launchArgs} onCommit={(value) => save({ launchArgs: value.trim() })} />
      </SettingsRow>
      <SettingsRow title="Custom models" description="Comma-separated Claude Code model IDs or aliases. Sonnet, Opus and Haiku are included.">
        <DraftInput className="mb-4 mt-3" aria-label="Custom Claude Code models" placeholder="e.g. sonnet[1m]" value={config.customModels.join(", ")} onCommit={(value) => save({ customModels: [...new Set(value.split(",").map((model) => model.trim()).filter(Boolean))] })} />
      </SettingsRow>
    </SettingsSection>
  );
}
