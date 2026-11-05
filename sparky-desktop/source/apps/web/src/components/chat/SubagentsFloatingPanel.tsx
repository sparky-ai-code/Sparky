import { memo, useMemo, useState } from "react";
import type { TimelineEntry } from "../../session-logic";
import { getModelProviderPresentation } from "./providerIconUtils";

interface SubagentInfo {
  id: string;
  name: string;
  task: string;
  model: string;
  provider: string;
  result?: string;
  isError?: boolean;
  isCancelled?: boolean;
  removed?: boolean;
}

function isSubagentInfo(value: unknown): value is SubagentInfo {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return data.kind === "subagent" && typeof data.id === "string" &&
    (data.removed === true || (typeof data.name === "string" &&
      typeof data.task === "string" && typeof data.model === "string" && typeof data.provider === "string"));
}

function getStatus(status: string, info: SubagentInfo) {
  if (info.isCancelled || status === "stopped") return "Stopped";
  if (info.isError || status === "failed") return "Failed";
  return status === "inProgress" ? "Working" : "Completed";
}

export const SubagentsFloatingPanel = memo(function SubagentsFloatingPanel(props: {
  entries: ReadonlyArray<TimelineEntry>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const subagents = useMemo(() => {
    const byId = new Map<string, { info: SubagentInfo; status: string }>();
    for (const timelineEntry of props.entries) {
      if (timelineEntry.kind !== "work" || !isSubagentInfo(timelineEntry.entry.toolData)) continue;
      const info = timelineEntry.entry.toolData;
      if (info.removed) {
        byId.delete(info.id);
      } else {
        byId.set(info.id, { info, status: timelineEntry.entry.toolLifecycleStatus ?? "inProgress" });
      }
    }
    return [...byId.values()].filter(({ info }) => !hiddenIds.has(info.id));
  }, [hiddenIds, props.entries]);

  const selected = subagents.find(({ info }) => info.id === selectedId);
  if (subagents.length === 0) return null;

  return (
    <aside
      aria-label="Subagents"
      className="absolute right-3 top-3 z-40 max-h-[min(28rem,65vh)] w-60 overflow-y-auto rounded-xl border border-white/10 bg-[#1e1e1e] p-3 text-white shadow-2xl"
      data-testid="subagents-floating-panel"
    >
      {selected ? (
        <>
          <header className="mb-4 flex items-center gap-2 border-b border-white/10 pb-3">
            <button type="button" className="rounded-md px-2 py-1 text-sm text-white/70 hover:bg-white/10 hover:text-white" onClick={() => setSelectedId(null)}>
              ← Back
            </button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold">{selected.info.name}</h2>
              <p className="text-xs text-white/50">{getStatus(selected.status, selected.info)}</p>
            </div>
          </header>
          <div className="space-y-3 text-sm">
            <div className="rounded-xl bg-white/[0.06] p-3">
              <p className="mb-1 text-xs font-medium text-white/45">Task</p>
              <p className="whitespace-pre-wrap">{selected.info.task}</p>
            </div>
            <div className="rounded-xl bg-white/[0.06] p-3">
              <p className="mb-1 text-xs font-medium text-white/45">{getStatus(selected.status, selected.info) === "Working" ? "Agent is working" : "Result"}</p>
              <p className="whitespace-pre-wrap">{selected.info.result || (selected.status === "inProgress" ? "Working…" : "No result was returned.")}</p>
            </div>
            <p className="text-xs text-white/45">{selected.info.model} · {selected.info.provider}</p>
          </div>
        </>
      ) : (
        <>
          <h2 className="mb-2 text-sm font-semibold tracking-wide">Subagents</h2>
          <ul className="space-y-1">
            {subagents.map(({ info, status }) => {
              const presentation = getModelProviderPresentation({ slug: info.model, subProvider: info.provider });
              const ModelIcon = presentation?.Icon;
              return (
                <li key={info.id} className="group flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-white/[0.06]">
                  {ModelIcon ? <ModelIcon className="size-4 shrink-0" aria-hidden /> : (
                    <span className="size-2 shrink-0 rounded-full bg-white/70" aria-hidden />
                  )}
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left hover:text-white"
                    onClick={() => setSelectedId(info.id)}
                    aria-label={`Open ${info.name} chat`}
                  >
                    <span className="block truncate text-[13px] font-medium">{info.name}</span>
                    <span className="block text-[11px] text-white/55">{getStatus(status, info)}</span>
                  </button>
                  <button
                    type="button"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-white/45 transition-colors hover:bg-red-500/15 hover:text-red-400 focus-visible:bg-red-500/15 focus-visible:text-red-400"
                    aria-label={`Remove ${info.name} from board`}
                    title={`Remove ${info.name} from board`}
                    onClick={() => setHiddenIds((current) => new Set([...current, info.id]))}
                  >
                    <span className="size-2 rounded-full bg-emerald-500 group-hover:hidden group-focus-within:hidden" aria-hidden />
                    <span className="hidden text-base leading-none group-hover:inline group-focus-within:inline" aria-hidden>×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
});
