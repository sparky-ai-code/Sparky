import { memo, useMemo } from "react";
import type { TimelineEntry } from "../../session-logic";
import { getModelProviderPresentation } from "./providerIconUtils";

interface SubagentInfo {
  name: string;
  model: string;
  provider: string;
  isError?: boolean;
}

function isSubagentInfo(value: unknown): value is SubagentInfo {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return data.kind === "subagent" && typeof data.name === "string" &&
    typeof data.model === "string" && typeof data.provider === "string";
}

export const SubagentsFloatingPanel = memo(function SubagentsFloatingPanel(props: {
  entries: ReadonlyArray<TimelineEntry>;
}) {
  const subagents = useMemo(() => {
    const byId = new Map<string, { info: SubagentInfo; status: string }>();
    for (const timelineEntry of props.entries) {
      if (timelineEntry.kind !== "work" || !isSubagentInfo(timelineEntry.entry.toolData)) continue;
      byId.set(timelineEntry.entry.id, {
        info: timelineEntry.entry.toolData,
        status: timelineEntry.entry.toolLifecycleStatus ?? "inProgress",
      });
    }
    return [...byId.values()];
  }, [props.entries]);

  if (subagents.length === 0) return null;
  return (
    <aside
      aria-label="Subagents"
      className="absolute right-4 top-1/2 z-40 max-h-[min(28rem,70vh)] w-60 -translate-y-1/2 overflow-y-auto rounded-[1.75rem] border border-white/10 bg-[#1e1e1e] p-5 text-white shadow-2xl"
      data-testid="subagents-floating-panel"
    >
      <h2 className="mb-5 text-sm font-semibold tracking-wide">Subagents</h2>
      <ul className="space-y-3">
        {subagents.map(({ info, status }, index) => {
          const presentation = getModelProviderPresentation({ slug: info.model });
          const ModelIcon = presentation?.Icon;
          const displayName = info.name.trim() || info.model;
          return (
            <li key={`${displayName}:${index}`} className="flex min-w-0 items-center gap-2.5 text-sm">
              {ModelIcon ? <ModelIcon className="size-5 shrink-0" aria-hidden /> : (
                <span className="size-2.5 shrink-0 rounded-full bg-white/70" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate" title={`${displayName} · ${info.model}`}>
                {displayName}
              </span>
              <span className="sr-only">{status}</span>
              <span
                className={`size-2 shrink-0 rounded-full ${
                  status === "inProgress" ? "animate-pulse bg-emerald-400" :
                    info.isError || status === "failed" ? "bg-red-400" : "bg-white/40"
                }`}
                aria-hidden
              />
            </li>
          );
        })}
      </ul>
    </aside>
  );
});
