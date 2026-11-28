import { useAtomValue } from "@effect/atom-react";
import { useCallback, useState } from "react";
import { ClaudeSettings, ProviderInstanceId } from "@sparky/contracts";
import * as Schema from "effect/Schema";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI } from "../Icons";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
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
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
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
  const refresh = useCallback(async () => {
    if (!environment) return false;
    setRefreshing(true);
    setRefreshError(false);
    try {
      const result = await refreshProviders({ environmentId: environment.environmentId, input: { instanceId } });
      const succeeded = result._tag !== "Failure";
      setRefreshError(!succeeded);
      return succeeded;
    } catch {
      setRefreshError(true);
      return false;
    } finally {
      setRefreshing(false);
    }
  }, [environment, refreshProviders]);
  const setUpAutomatically = async () => {
    if (!enabled) {
      await refresh();
      setSetupDialogOpen(true);
      return;
    }
    void refresh();
  };
  const confirmSetup = () => {
    save({ enabled: true });
    setSetupDialogOpen(false);
  };

  const detectedSnapshot = snapshot?.installed ? snapshot : undefined;
  const detected = detectedSnapshot !== undefined;
  const status = refreshError
    ? "Could not refresh Claude Code status."
    : !enabled
      ? "Not set up yet. Sparky can detect the CLI and enable its models automatically."
      : snapshot?.message ?? (snapshot?.installed
        ? `${snapshot.version ?? "Claude Code detected"} · ${snapshot.models.length} models ready${snapshot.executablePath ? ` · ${snapshot.executablePath}` : ""}`
        : "Waiting for provider status…");

  return (
    <>
      <SettingsSection title="Claude Code" icon={<ClaudeAI className="size-3.5" />}>
        <SettingsRow
          title="Claude Code CLI"
          description={<>Let Sparky find Claude Code on the backend, check its sign-in, and set up the available models. No fields are required for a standard setup. <a className="underline" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">Install Claude Code</a> if it is not installed.</>}
          status={status}
          control={<>
            <Button variant="outline" size="sm" disabled={!environment || refreshing} onClick={setUpAutomatically}>
              {refreshing ? "Detecting…" : "Set up automatically"}
            </Button>
            <Switch checked={enabled} disabled={!environment} onCheckedChange={(next) => save({ enabled: next })} aria-label="Enable Claude Code" />
          </>}
        />
        <details className="border-t border-border/60 px-4 py-3.5 sm:px-5">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">Advanced settings</summary>
          <div className="-mx-4 mt-3 sm:-mx-5">
            <SettingsRow title="Executable" description="Override the automatically detected Claude Code executable. On Windows, use the native claude.exe.">
              <DraftInput className="mb-4 mt-3" aria-label="Claude Code executable" placeholder="Automatically detected" value={config.binaryPath === "claude" ? "" : config.binaryPath} onCommit={(value) => save({ binaryPath: value.trim() || "claude" })} />
            </SettingsRow>
            <SettingsRow title="Config directory" description="Optional CLAUDE_CONFIG_DIR. Leave blank to use your existing Claude Code login and chats.">
              <DraftInput className="mb-4 mt-3" aria-label="Claude Code config directory" placeholder="Automatically detected (~/.claude)" value={config.homePath} onCommit={(value) => save({ homePath: value.trim() })} />
            </SettingsRow>
            <SettingsRow title="Launch arguments" description="Optional additional CLI arguments compatible with stream-json sessions.">
              <DraftInput className="mb-4 mt-3" aria-label="Claude Code launch arguments" placeholder="e.g. --chrome" value={config.launchArgs} onCommit={(value) => save({ launchArgs: value.trim() })} />
            </SettingsRow>
            <SettingsRow title="Custom models" description="Optional comma-separated model IDs or aliases. Sonnet, Opus, Haiku, and Fable are included automatically.">
              <DraftInput className="mb-4 mt-3" aria-label="Custom Claude Code models" placeholder="e.g. sonnet[1m]" value={config.customModels.join(", ")} onCommit={(value) => save({ customModels: [...new Set(value.split(",").map((model) => model.trim()).filter(Boolean))] })} />
            </SettingsRow>
          </div>
        </details>
      </SettingsSection>
      <Dialog open={setupDialogOpen} onOpenChange={setSetupDialogOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{refreshError ? "Detection unavailable" : detected ? "Claude Code detected" : "Claude Code not detected"}</DialogTitle>
            <DialogDescription>
              {refreshError
                ? "Sparky could not complete detection. Check the connection to this environment and try again."
                : detected
                  ? "Sparky found Claude Code. Confirm to enable it as a model provider. This does not change Claude Code files or credentials."
                  : "Sparky could not find Claude Code on this environment. Install it or set an executable path in Advanced settings, then try again."}
            </DialogDescription>
          </DialogHeader>
          {detectedSnapshot && <DialogPanel className="space-y-2 text-sm">
            <p>{detectedSnapshot.version ?? "Installed"}{detectedSnapshot.executablePath ? <> · <code className="break-all">{detectedSnapshot.executablePath}</code></> : null}</p>
            <p>Models: {detectedSnapshot.models.map((model) => model.name).join(", ") || "none found"}</p>
            {detectedSnapshot.auth.status === "unauthenticated" && <p className="text-muted-foreground">Claude Code is not signed in on this environment. Run <code>claude auth login</code> there before using it.</p>}
          </DialogPanel>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetupDialogOpen(false)}>Cancel</Button>
            <Button disabled={!detected || refreshError} onClick={confirmSetup}>Enable Claude Code</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
