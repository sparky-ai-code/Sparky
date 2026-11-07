import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, GitPullRequestIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { readLocalModelAnalyticsEvents, type LocalModelUsageEvent } from "../../account/modelAnalytics";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useProjects, useThreadShells } from "../../state/entities";
import { scopeThreadRef } from "@sparky/client-runtime/environment";
import { Button } from "../ui/button";
import {
  readRecentPullRequestCache,
  refreshRecentPullRequests,
  subscribeRecentPullRequestCache,
  type CachedPullRequest,
} from "../pullRequests/recentPullRequestCache";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHART_DAYS = 364;

type DayUsage = { date: string; tokens: number; cost: number };

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function buildDays(events: ReadonlyArray<LocalModelUsageEvent>): DayUsage[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const totals = new Map<string, DayUsage>();
  for (let index = CHART_DAYS - 1; index >= 0; index -= 1) {
    const date = new Date(today.getTime() - index * DAY_MS);
    const key = dateKey(date);
    totals.set(key, { date: key, tokens: 0, cost: 0 });
  }
  for (const event of events) {
    const day = totals.get(dateKey(new Date(event.occurredAt)));
    if (day) {
      day.tokens += event.totalTokens ?? ((event.inputTokens ?? 0) + (event.outputTokens ?? 0));
      day.cost += event.costUsd ?? 0;
    }
  }
  return [...totals.values()];
}

function formatCount(value: number): string {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function UsageActivity() {
  const [events, setEvents] = useState<ReadonlyArray<LocalModelUsageEvent>>(() => readLocalModelAnalyticsEvents());
  useEffect(() => {
    const refresh = () => setEvents(readLocalModelAnalyticsEvents());
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("storage", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  const days = useMemo(() => buildDays(events), [events]);
  const totalTokens = days.reduce((sum, day) => sum + day.tokens, 0);
  const totalSpend = days.reduce((sum, day) => sum + day.cost, 0);
  const maxTokens = Math.max(1, ...days.map((day) => day.tokens));
  return (
    <section className="min-w-0 rounded-2xl border border-border/60 bg-card/65 p-4" aria-label="Recent activity">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Activity</h2>
          <p className="mt-1 text-xs text-muted-foreground">{formatCount(totalTokens)} tokens in the past year</p>
        </div>
        <span className="text-xs text-muted-foreground">Last 12 months</span>
      </div>
      <div className="grid grid-flow-col grid-rows-7 gap-1 overflow-x-auto pb-1" role="img" aria-label="Daily token usage for the past year">
        {days.map((day) => {
          const level = day.tokens === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((day.tokens / maxTokens) * 4)));
          return (
            <span
              key={day.date}
              title={`${new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(new Date(`${day.date}T12:00:00`))}: ${formatCount(day.tokens)} tokens`}
              aria-label={`${day.date}: ${day.tokens} tokens`}
              className={`size-2.5 rounded-[2px] ${level === 0 ? "bg-muted" : level === 1 ? "bg-primary/25" : level === 2 ? "bg-primary/45" : level === 3 ? "bg-primary/70" : "bg-primary"}`}
            />
          );
        })}
      </div>
      <div className="mt-3 border-t border-border/50 pt-3 text-xs text-muted-foreground">
        Estimated model spend <span className="ml-1 font-medium text-foreground">{new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(totalSpend)}</span>
      </div>
    </section>
  );
}

function RecentThreads() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const recent = useMemo(
    () => [...threads].filter((thread) => thread.archivedAt === null).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 5),
    [threads],
  );
  return (
    <section className="min-w-0 rounded-2xl border border-border/60 bg-card/65 p-4">
      <div className="mb-3 flex items-center gap-2">
        <MessageSquareIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">Recent threads</h2>
      </div>
      {recent.length === 0 ? (
        <p className="text-xs text-muted-foreground">Your recent conversations will show up here.</p>
      ) : (
        <ul className="space-y-1">
          {recent.map((thread) => (
            <li key={`${thread.environmentId}:${thread.id}`}>
              <button
                type="button"
                className="group flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm text-foreground/85 transition-colors hover:bg-muted/70"
                onClick={() => void navigate({ to: "/_chat/$environmentId/$threadId", params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)) })}
              >
                <span className="min-w-0 truncate">{thread.title}</span>
                <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentPullRequests() {
  const navigate = useNavigate();
  const projects = useProjects();
  const projectCwds = useMemo(
    () => [...new Set(projects.map((project) => project.workspaceRoot).filter(Boolean))],
    [projects],
  );
  const [pullRequests, setPullRequests] = useState<ReadonlyArray<CachedPullRequest>>(() => readRecentPullRequestCache());
  useEffect(() => {
    void refreshRecentPullRequests(projectCwds);
  }, [projectCwds]);
  useEffect(() => subscribeRecentPullRequestCache(() => setPullRequests(readRecentPullRequestCache())), []);
  const openPullRequests = pullRequests.filter((pullRequest) => pullRequest.state.toLowerCase() === "open").slice(0, 3);
  return (
    <section className="rounded-2xl border border-border/60 bg-card/65 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground"><GitPullRequestIcon className="size-4 text-muted-foreground" />Pull requests</h2>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void navigate({ to: "/pull-requests" })}>
          All <ArrowUpRightIcon className="size-3.5" />
        </Button>
      </div>
      {openPullRequests.length ? (
        <ul className="space-y-1">
          {openPullRequests.map((pullRequest) => (
            <li key={`${pullRequest.repository}#${pullRequest.number}`}>
              <a href={pullRequest.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center justify-between gap-2 rounded-lg px-2 py-2 text-sm text-foreground/85 hover:bg-muted/70">
                <span className="min-w-0 truncate">{pullRequest.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{pullRequest.repository} #{pullRequest.number}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No open pull requests to show right now.</p>
      )}
    </section>
  );
}

export function ChatHomeContext() {
  return (
    <div className="pointer-events-auto mx-auto grid w-full max-w-5xl grid-cols-1 gap-3 px-4 pb-6 pt-5 md:grid-cols-[1.3fr_1fr] md:px-8">
      <UsageActivity />
      <div className="flex min-w-0 flex-col gap-3">
        <RecentThreads />
        <RecentPullRequests />
      </div>
    </div>
  );
}
