import { LoaderCircleIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PluginLogo } from "../plugins/PluginLogo";
import {
  disconnectPlugin,
  listPluginStatus,
  loadPluginSessionToken,
  type PluginStatus,
} from "../plugins/pluginApi";
import { getPluginById, type PluginId } from "../plugins/pluginCatalog";
import { Button } from "../ui/button";

type GitHubDisconnectBridge = {
  readonly disconnectGitHub?: () => Promise<unknown>;
};

function metadataSummary(status: PluginStatus): string | null {
  const metadata = status.metadata;
  if (!metadata) return null;
  for (const key of ["login", "teamName", "workspaceName", "siteName"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function PluginsSettingsPanel() {
  const [statuses, setStatuses] = useState<PluginStatus[]>([]);
  const [busyPluginId, setBusyPluginId] = useState<PluginId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (options: { readonly forceRefresh?: boolean } = {}) => {
    const sessionToken = loadPluginSessionToken();
    if (!sessionToken) {
      setStatuses([]);
      return;
    }
    try {
      setStatuses(await listPluginStatus(sessionToken, options));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Installed plugins could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installed = useMemo(
    () =>
      statuses
        .filter((status) => status.connected)
        .flatMap((status) => {
          const plugin = getPluginById(status.pluginId);
          return plugin ? [{ plugin, status }] : [];
        }),
    [statuses],
  );

  const remove = useCallback(
    async (pluginId: PluginId) => {
      const sessionToken = loadPluginSessionToken();
      if (!sessionToken || busyPluginId) return;
      setBusyPluginId(pluginId);
      setError(null);
      try {
        await disconnectPlugin(sessionToken, pluginId);
        if (pluginId === "github") {
          const bridge = window.desktopBridge as unknown as GitHubDisconnectBridge | undefined;
          await bridge?.disconnectGitHub?.();
        }
        await refresh({ forceRefresh: true });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Plugin could not be deleted.");
      } finally {
        setBusyPluginId(null);
      }
    },
    [busyPluginId, refresh],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8 sm:py-10">
        <div className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Plugins</h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            View and remove the plugins currently connected to your Sparky account.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card/45">
          {installed.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-medium text-foreground">No installed plugins</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Plugins you connect from the Plugins page will appear here.
              </p>
            </div>
          ) : (
            installed.map(({ plugin, status }, index) => {
              const summary = metadataSummary(status);
              const busy = busyPluginId === plugin.id;
              return (
                <div
                  key={plugin.id}
                  className={
                    index === 0
                      ? "flex items-center gap-4 px-4 py-4"
                      : "flex items-center gap-4 border-t border-border/70 px-4 py-4"
                  }
                >
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-border/70 bg-background/65">
                    <PluginLogo pluginId={plugin.id} className="size-6" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-medium text-foreground">{plugin.name}</p>
                      <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        Installed
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {summary ?? plugin.description}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busyPluginId !== null}
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => void remove(plugin.id)}
                  >
                    {busy ? (
                      <LoaderCircleIcon className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                    Delete
                  </Button>
                </div>
              );
            })
          )}
        </div>

        {error ? (
          <p role="status" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
