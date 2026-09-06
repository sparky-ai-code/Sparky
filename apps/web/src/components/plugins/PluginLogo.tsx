import { cn } from "../../lib/utils";
import type { PluginId } from "./pluginCatalog";

const DARK_INVERTED_LOGOS: ReadonlySet<PluginId> = new Set(["github", "notion"]);

export function PluginLogo({
  pluginId,
  className,
}: {
  readonly pluginId: PluginId;
  readonly className?: string;
}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn(
        "size-5 shrink-0 object-contain",
        DARK_INVERTED_LOGOS.has(pluginId) && "dark:invert",
        className,
      )}
      src={`${import.meta.env.BASE_URL}plugin-logos/${pluginId}.svg`}
    />
  );
}
