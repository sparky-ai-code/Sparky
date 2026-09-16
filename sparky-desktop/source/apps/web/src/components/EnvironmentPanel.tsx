import type { PreviewSessionSnapshot, ScopedThreadRef, VcsStatusResult } from "@sparky/contracts";
import {
  Activity,
  ExternalLink,
  FileDiff,
  GitBranch,
  Globe2,
  Network,
  Play,
  Server,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useEnvironmentQuery } from "../state/query";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { vcsEnvironment } from "../state/vcs";
import { useThreadPreviewState } from "../previewStateStore";
import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "~/lib/utils";

const MAX_VISIBLE_ITEMS = 3;

export interface EnvironmentPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | null | undefined;
  readonly onOpenDiff: () => void;
  readonly onOpenTerminal: (terminalId: string) => void;
  readonly onOpenBrowser: (tabId: string) => void;
}

function previewTitle(snapshot: PreviewSessionSnapshot): string {
  if (snapshot.navStatus._tag === "Idle") return "New browser tab";
  if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
  try {
    return new URL(snapshot.navStatus.url).host || snapshot.navStatus.url;
  } catch {
    return snapshot.navStatus.url;
  }
}

function statusBadgeVariant(
  status: string,
): "default" | "destructive" | "info" | "outline" | "secondary" | "success" | "warning" {
  switch (status) {
    case "completed":
    case "Completed":
    case "connected":
    case "running":
      return status === "running" ? "info" : "success";
    case "failed":
    case "Failed":
    case "error":
      return "destructive";
    case "waiting":
    case "Waiting":
    case "Starting":
    case "Verifying":
      return "warning";
    default:
      return "secondary";
  }
}

function Section(props: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
  readonly empty: ReactNode;
}) {
  return (
    <section className="space-y-2" aria-labelledby={`environment-section-${props.title}`}>
      <div className="flex items-center justify-between gap-2">
        <h3
          id={`environment-section-${props.title}`}
          className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold tracking-widest text-muted-foreground/60 uppercase"
        >
          {props.icon}
          <span className="truncate">{props.title}</span>
          <span className="text-muted-foreground/40 tabular-nums">{props.count}</span>
        </h3>
        {props.count > MAX_VISIBLE_ITEMS ? (
          <button
            type="button"
            className="text-[11px] text-muted-foreground/60 hover:text-foreground"
            onClick={props.onToggle}
          >
            {props.expanded ? "Show less" : "Show all"}
          </button>
        ) : null}
      </div>
      {props.count > 0 ? props.children : props.empty}
    </section>
  );
}

function EnvironmentRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail?: string;
  readonly status?: string;
  readonly onClick?: () => void;
  readonly className?: string;
}) {
  const content = (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground">
        {props.icon}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-xs text-foreground/90">{props.label}</span>
        {props.detail ? (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/60">
            {props.detail}
          </span>
        ) : null}
      </span>
      {props.status ? (
        <Badge variant={statusBadgeVariant(props.status)} size="sm" className="capitalize">
          {props.status}
        </Badge>
      ) : null}
      {props.onClick ? <ExternalLink className="size-3 shrink-0 text-muted-foreground/40" /> : null}
    </>
  );

  if (!props.onClick) {
    return (
      <div className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5", props.className)}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/60",
        props.className,
      )}
      onClick={props.onClick}
    >
      {content}
    </button>
  );
}

function EmptySection({ children }: { readonly children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border/60 px-3 py-2 text-[11px] text-muted-foreground/50">
      {children}
    </p>
  );
}

function GitSection(props: {
  readonly status: VcsStatusResult | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenDiff: () => void;
}) {
  const files = props.status?.workingTree.files ?? [];
  const branch = props.status?.refName ?? "No branch";
  return (
    <Section
      title="Git changes"
      icon={<GitBranch className="size-3" />}
      count={files.length}
      expanded={props.expanded}
      onToggle={props.onToggle}
      empty={
        <EmptySection>
          {props.error ??
            (props.isPending
              ? "Loading repository status…"
              : props.status?.isRepo === false
                ? "This workspace is not a Git repository."
                : `Clean on ${branch}.`)}
        </EmptySection>
      }
    >
      <div className="space-y-1">
        <div className="flex items-center justify-between px-2 text-[11px] text-muted-foreground/60">
          <span className="truncate">{branch}</span>
          <span className="tabular-nums">
            +{props.status?.workingTree.insertions ?? 0} / -
            {props.status?.workingTree.deletions ?? 0}
          </span>
        </div>
        {files.slice(0, props.expanded ? undefined : MAX_VISIBLE_ITEMS).map((file) => (
          <EnvironmentRow
            key={file.path}
            icon={<FileDiff className="size-3.5" />}
            label={file.path}
            detail={`+${file.insertions} / -${file.deletions}`}
            onClick={props.onOpenDiff}
          />
        ))}
      </div>
    </Section>
  );
}

export function EnvironmentPanel(props: EnvironmentPanelProps) {
  const [expandedSections, setExpandedSections] = useState<ReadonlySet<string>>(new Set());
  const gitStatusQuery = useEnvironmentQuery(
    props.cwd
      ? vcsEnvironment.status({
          environmentId: props.threadRef.environmentId,
          input: { cwd: props.cwd },
        })
      : null,
  );
  const terminalSessions = useKnownTerminalSessions({
    environmentId: props.threadRef.environmentId,
    threadId: props.threadRef.threadId,
  });
  const previewState = useThreadPreviewState(props.threadRef);
  const discoveredPorts = useThreadDiscoveredPorts({
    environmentId: props.threadRef.environmentId,
    threadId: props.threadRef.threadId,
  });
  const previewSessions = useMemo(
    () =>
      Object.values(previewState.sessions).filter(
        (session) => !previewState.suppressedTabIds.has(session.tabId),
      ),
    [previewState.sessions, previewState.suppressedTabIds],
  );
  const toggleSection = (section: string) => {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };
  const isExpanded = (section: string) => expandedSections.has(section);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-card/50">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Workflow className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">Environment</h2>
            <p className="truncate text-[11px] text-muted-foreground/60">
              {props.cwd ?? "Thread-scoped resources"}
            </p>
          </div>
        </div>
        <Badge variant="info" size="sm" className="gap-1">
          <Activity className="size-3" /> Live
        </Badge>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-3">
          <GitSection
            status={gitStatusQuery.data}
            isPending={gitStatusQuery.isPending}
            error={gitStatusQuery.error}
            expanded={isExpanded("git")}
            onToggle={() => toggleSection("git")}
            onOpenDiff={props.onOpenDiff}
          />

          <Section
            title="Terminals & processes"
            icon={<TerminalSquare className="size-3" />}
            count={terminalSessions.length}
            expanded={isExpanded("terminals")}
            onToggle={() => toggleSection("terminals")}
            empty={<EmptySection>No terminals are attached to this thread.</EmptySection>}
          >
            <div className="space-y-1">
              {terminalSessions
                .slice(0, isExpanded("terminals") ? undefined : MAX_VISIBLE_ITEMS)
                .map((session) => {
                  const summary = session.state.summary;
                  const running = session.state.hasRunningSubprocess;
                  return (
                    <EnvironmentRow
                      key={session.target.terminalId}
                      icon={
                        running ? (
                          <Play className="size-3.5" />
                        ) : (
                          <TerminalSquare className="size-3.5" />
                        )
                      }
                      label={summary?.label || session.target.terminalId}
                      detail={summary?.cwd ?? "Terminal session"}
                      status={running ? "running" : (summary?.status ?? "ready")}
                      onClick={() => props.onOpenTerminal(session.target.terminalId)}
                    />
                  );
                })}
            </div>
          </Section>

          <Section
            title="Browser resources"
            icon={<Globe2 className="size-3" />}
            count={previewSessions.length}
            expanded={isExpanded("browsers")}
            onToggle={() => toggleSection("browsers")}
            empty={<EmptySection>No browser tabs are open for this thread.</EmptySection>}
          >
            <div className="space-y-1">
              {previewSessions
                .slice(0, isExpanded("browsers") ? undefined : MAX_VISIBLE_ITEMS)
                .map((session) => (
                  <EnvironmentRow
                    key={session.tabId}
                    icon={<Globe2 className="size-3.5" />}
                    label={previewTitle(session)}
                    detail={
                      session.navStatus._tag === "Idle" ? "Ready for a URL" : session.navStatus.url
                    }
                    status={
                      session.navStatus._tag === "LoadFailed" ? "error" : session.navStatus._tag
                    }
                    onClick={() => props.onOpenBrowser(session.tabId)}
                  />
                ))}
            </div>
          </Section>

          <Section
            title="Local ports"
            icon={<Network className="size-3" />}
            count={discoveredPorts.length}
            expanded={isExpanded("ports")}
            onToggle={() => toggleSection("ports")}
            empty={<EmptySection>No local ports detected for this thread.</EmptySection>}
          >
            <div className="space-y-1">
              {discoveredPorts
                .slice(0, isExpanded("ports") ? undefined : MAX_VISIBLE_ITEMS)
                .map((port) => (
                  <EnvironmentRow
                    key={`${port.host}:${port.port}`}
                    icon={<Server className="size-3.5" />}
                    label={`${port.host}:${port.port}`}
                    detail={port.processName ?? port.url}
                    status="available"
                  />
                ))}
            </div>
          </Section>
        </div>
      </ScrollArea>
    </div>
  );
}
