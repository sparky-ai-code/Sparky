import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { PluginLogo } from "./PluginLogo";
import {
  connectPlugin,
  disconnectPlugin,
  listPluginStatus,
  loadPluginSessionToken,
  type PluginStatus,
} from "./pluginApi";
import { PLUGINS, matchesPlugin, type PluginDefinition, type PluginId } from "./pluginCatalog";

type GitHubDisconnectBridge = {
  readonly disconnectGitHub?: () => Promise<unknown>;
};

function PluginTile({
  plugin,
  connected,
  busy,
  onConnect,
  onDisconnect,
}: {
  readonly plugin: PluginDefinition;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly onConnect: (pluginId: PluginId) => void;
  readonly onDisconnect: (pluginId: PluginId) => void;
}) {
  return (
    <div className="group flex w-[88px] flex-col items-center gap-2 justify-self-center">
      <div
        className={cn(
          "flex h-[80px] w-[80px] flex-col items-center justify-center gap-1.5 rounded-[16px] border",
          "border-black/10 bg-white/55 shadow-[0_8px_30px_rgba(15,23,42,0.055),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl",
          "dark:border-white/12 dark:bg-white/[0.055] dark:shadow-[0_10px_36px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.09)]",
        )}
      >
        <PluginLogo pluginId={plugin.id} className="size-8 opacity-100" />
        <span className="max-w-[70px] truncate text-[10px] font-medium leading-none text-foreground/90">
          {plugin.name}
        </span>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => (connected ? onDisconnect(plugin.id) : onConnect(plugin.id))}
        className={cn(
          "h-5 min-w-[58px] rounded-[5px] border border-border/75 bg-background/55 px-2 text-[9px] text-foreground/80 backdrop-blur-xl transition",
          "hover:bg-accent/65 hover:text-foreground disabled:cursor-wait disabled:opacity-45",
          connected && "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
        )}
      >
        {busy ? "…" : connected ? "Disconnect" : "Connect"}
      </button>
    </div>
  );
}

export function PluginsPage() {
  const [query, setQuery] = useState("");
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
      setError(cause instanceof Error ? cause.message : "Plugins could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connectedIds = useMemo(
    () => new Set(statuses.filter((entry) => entry.connected).map((entry) => entry.pluginId)),
    [statuses],
  );
  const visiblePlugins = useMemo(
    () => PLUGINS.filter((plugin) => matchesPlugin(plugin, query)),
    [query],
  );
  const installed = visiblePlugins.filter((plugin) => connectedIds.has(plugin.id));
  const explore = visiblePlugins.filter((plugin) => !connectedIds.has(plugin.id));

  const connect = useCallback(
    async (pluginId: PluginId) => {
      const sessionToken = loadPluginSessionToken();
      if (!sessionToken || busyPluginId) return;
      setBusyPluginId(pluginId);
      setError(null);
      try {
        await connectPlugin(sessionToken, pluginId);
        await refresh({ forceRefresh: true });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Plugin authorization failed.");
      } finally {
        setBusyPluginId(null);
      }
    },
    [busyPluginId, refresh],
  );

  const disconnect = useCallback(
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
        setError(cause instanceof Error ? cause.message : "Plugin could not be disconnected.");
      } finally {
        setBusyPluginId(null);
      }
    },
    [busyPluginId, refresh],
  );

  return (
    <main className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-[960px] px-8 pb-16 pt-14">
        <div className="relative mx-auto w-full max-w-[600px]">
          <Input
            aria-label="Search plugins"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="h-9 rounded-xl border-border/75 bg-background/45 pr-9 text-xs shadow-none backdrop-blur-xl"
          />
          <SearchIcon className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-foreground/70" />
        </div>

        {installed.length > 0 ? (
          <section className="mx-auto mt-10 max-w-[600px]">
            <h1 className="text-xs font-medium text-foreground/70">Installed</h1>
            <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
              {installed.map((plugin) => (
                <PluginTile
                  key={plugin.id}
                  plugin={plugin}
                  connected
                  busy={busyPluginId === plugin.id}
                  onConnect={connect}
                  onDisconnect={disconnect}
                />
              ))}
            </div>
          </section>
        ) : null}

        <section className={cn("mx-auto max-w-[600px]", installed.length > 0 ? "mt-12" : "mt-14")}>
          <h2 className="text-center text-xl font-medium tracking-[-0.02em] text-foreground/90">
            Explore more
          </h2>
          <div className="mx-auto mt-8 grid max-w-[520px] grid-cols-2 gap-x-7 gap-y-7 sm:grid-cols-4">
            {explore.map((plugin) => (
              <PluginTile
                key={plugin.id}
                plugin={plugin}
                connected={false}
                busy={busyPluginId === plugin.id}
                onConnect={connect}
                onDisconnect={disconnect}
              />
            ))}
          </div>
        </section>

        {visiblePlugins.length === 0 ? (
          <p className="mx-auto mt-8 max-w-[600px] text-center text-xs text-muted-foreground">
            No plugins match your search.
          </p>
        ) : null}

        {error ? (
          <p
            role="status"
            className="mx-auto mt-6 max-w-[600px] text-center text-[10px] text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
