import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAccountState } from "../../account/AccountAuthProvider";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { PluginLogo } from "./PluginLogo";
import {
  listPluginStatus,
  loadPluginSessionToken,
  type PluginStatus,
} from "./pluginApi";
import { PLUGINS, type PluginId } from "./pluginCatalog";

export function ComposerPluginDock(props: {
  readonly onPluginSelect?: (pluginId: PluginId) => void;
}) {
  const navigate = useNavigate();
  const account = useAccountState();
  const pluginSessionReady =
    account.status === "signed-in" && account.pluginSessionReady;
  const [statuses, setStatuses] = useState<PluginStatus[]>([]);

  useEffect(() => {
    if (!pluginSessionReady) {
      setStatuses([]);
      return;
    }

    const sessionToken = loadPluginSessionToken();
    if (!sessionToken) {
      setStatuses([]);
      return;
    }

    let cancelled = false;
    void listPluginStatus(sessionToken)
      .then((nextStatuses) => {
        if (!cancelled) setStatuses(nextStatuses);
      })
      .catch(() => {
        if (!cancelled) setStatuses([]);
      });

    return () => {
      cancelled = true;
    };
  }, [pluginSessionReady]);

  const installedPlugins = PLUGINS.filter((plugin) =>
    statuses.some(
      (status) => status.pluginId === plugin.id && status.connected,
    ),
  );

  return (
    <div
      className="flex shrink-0 items-center rounded-full border border-border/65 bg-background/35 px-1 py-0.5 shadow-sm backdrop-blur-xl"
      data-composer-plugin-dock="true"
    >
      <div className="flex items-center pr-1" aria-label="Installed plugins">
        {installedPlugins.map((plugin, index) => (
          <button
            key={plugin.id}
            type="button"
            className={cn(
              "relative flex size-6 shrink-0 items-center justify-center rounded-full border border-border/80 bg-background/90 p-1 shadow-sm outline-none",
              "transition-[transform,box-shadow] duration-200 ease-out hover:z-30 hover:-translate-y-1.5 hover:shadow-lg focus-visible:z-30 focus-visible:-translate-y-1.5 focus-visible:ring-2 focus-visible:ring-ring",
            )}
            style={{ marginLeft: index === 0 ? 0 : -7 }}
            title={`Add ${plugin.name} to chat`}
            aria-label={`Add ${plugin.name} to chat`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => props.onPluginSelect?.(plugin.id)}
          >
            <PluginLogo pluginId={plugin.id} className="size-4" />
          </button>
        ))}
      </div>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="size-6 shrink-0 rounded-full text-muted-foreground/75 hover:text-foreground"
        aria-label="Open plugins"
        title="Add a plugin"
        onClick={() => void navigate({ to: "/plugins" })}
      >
        <PlusIcon className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
