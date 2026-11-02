import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIcon, BarChart3Icon, CoinsIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";

import {
  readLocalModelAnalyticsEvents,
  type LocalModelUsageEvent,
} from "../../account/modelAnalytics";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOWS)[number];
type DailyUsage = {
  readonly date: string;
  readonly turns: number;
  readonly tokens: number;
  readonly costUsd: number;
};

type ModelUsage = {
  readonly provider: string;
  readonly model: string;
  readonly turns: number;
  readonly tokens: number;
};

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function formatCount(value: number): string {
  return Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(`${date}T12:00:00`),
  );
}

function MiniTrend({ rows }: { rows: ReadonlyArray<DailyUsage> }) {
  const max = Math.max(1, ...rows.map((row) => row.tokens));
  const points = rows
    .map((row, index) => {
      const x = rows.length < 2 ? 0 : (index / (rows.length - 1)) * 100;
      const y = 34 - (row.tokens / max) * 30;
      return `${x},${y}`;
    })
    .join(" ");
  if (rows.length === 0) {
    return (
      <div className="grid h-44 place-items-center text-sm text-muted-foreground">
        No usage recorded in this period.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        role="img"
        aria-label="Daily token usage trend"
        className="h-44 w-full overflow-visible"
      >
        <defs>
          <linearGradient id="usage-chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" className="[stop-color:var(--color-primary)]" stopOpacity=".24" />
            <stop offset="100%" className="[stop-color:var(--color-primary)]" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,40 ${points} 100,40`} fill="url(#usage-chart-fill)" />
        <polyline
          points={points}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth=".8"
          vectorEffect="non-scaling-stroke"
        />
        {rows.map((row, index) => {
          const x = rows.length < 2 ? 50 : (index / (rows.length - 1)) * 100;
          const y = 34 - (row.tokens / max) * 30;
          return (
            <circle key={row.date} cx={x} cy={y} r="1.4" fill="var(--color-primary)">
              <title>{`${formatDate(row.date)}: ${formatCount(row.tokens)} tokens, ${row.turns} turns`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{formatDate(rows[0]!.date)}</span>
        <span>{formatDate(rows[rows.length - 1]!.date)}</span>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

export function UserAnalyticsSettingsPanel() {
  const [events, setEvents] = useState<ReadonlyArray<LocalModelUsageEvent>>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState<WindowDays>(30);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    setEvents(readLocalModelAnalyticsEvents());
    setLoading(false);
  }, [refreshToken]);

  const periodEvents = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    return events.filter(
      (event) =>
        Number.isFinite(Date.parse(event.occurredAt)) &&
        event.occurredAt.slice(0, 10) >= cutoffDate,
    );
  }, [days, events]);

  const usageRows = useMemo(() => {
    const totalsByDate = new Map<string, DailyUsage>();
    for (const event of periodEvents) {
      const date = event.occurredAt.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(event.occurredAt)))
        continue;
      const current = totalsByDate.get(date) ?? { date, turns: 0, tokens: 0, costUsd: 0 };
      totalsByDate.set(date, {
        date,
        turns: current.turns + 1,
        tokens: current.tokens + numberOrZero(event.totalTokens),
        costUsd: current.costUsd + numberOrZero(event.costUsd),
      });
    }
    return [...totalsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [periodEvents]);

  const totals = useMemo(
    () =>
      periodEvents.reduce(
        (acc, event) => ({
          turns: acc.turns + 1,
          tokens: acc.tokens + numberOrZero(event.totalTokens),
          cost: acc.cost + numberOrZero(event.costUsd),
          costEvents: acc.costEvents + (event.costUsd === undefined ? 0 : 1),
        }),
        { turns: 0, tokens: 0, cost: 0, costEvents: 0 },
      ),
    [periodEvents],
  );

  const modelRows = useMemo(() => {
    const byModel = new Map<string, ModelUsage>();
    for (const event of periodEvents) {
      const key = `${event.provider}:${event.model}`;
      const current = byModel.get(key) ?? {
        provider: event.provider,
        model: event.model,
        turns: 0,
        tokens: 0,
      };
      byModel.set(key, {
        ...current,
        turns: current.turns + 1,
        tokens: current.tokens + numberOrZero(event.totalTokens),
      });
    }
    return [...byModel.values()].sort((a, b) => b.turns - a.turns || b.tokens - a.tokens);
  }, [periodEvents]);

  const providerRows = useMemo(() => {
    const totalsByProvider = new Map<string, { turns: number; tokens: number }>();
    for (const item of modelRows) {
      const current = totalsByProvider.get(item.provider) ?? { turns: 0, tokens: 0 };
      current.turns += item.turns;
      current.tokens += item.tokens;
      totalsByProvider.set(item.provider, current);
    }
    return [...totalsByProvider.entries()]
      .map(([provider, values]) => ({ provider, ...values }))
      .sort((a, b) => b.turns - a.turns);
  }, [modelRows]);

  const maxProviderTurns = Math.max(1, ...providerRows.map((row) => row.turns));
  const maxModelTurns = Math.max(1, ...modelRows.map((row) => row.turns));

  return (
    <SettingsPageContainer className="max-w-5xl gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Usage analytics</h1>
          <p className="text-sm text-muted-foreground">
            A private view of your provider, model, and token usage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex rounded-lg border border-border/70 p-0.5"
            role="group"
            aria-label="Analytics time range"
          >
            {WINDOWS.map((window) => (
              <button
                key={window}
                type="button"
                aria-pressed={days === window}
                onClick={() => setDays(window)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${days === window ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {window} days
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-label="Refresh analytics"
            onClick={() => setRefreshToken((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="rounded-xl border border-border/70 bg-card p-8 text-center text-sm text-muted-foreground">
          Loading your usage…
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              icon={<ActivityIcon className="size-3.5" />}
              label="Turns"
              value={formatCount(totals.turns)}
              hint={`Across the last ${days} days`}
            />
            <MetricCard
              icon={<SparklesIcon className="size-3.5" />}
              label="Tokens"
              value={formatCount(totals.tokens)}
              hint="Reported by your providers"
            />
            <MetricCard
              icon={<CoinsIcon className="size-3.5" />}
              label="Estimated cost"
              value={totals.costEvents > 0 ? `$${totals.cost.toFixed(2)}` : "—"}
              hint={
                totals.costEvents > 0
                  ? `Reported for ${formatCount(totals.costEvents)} turns`
                  : "No provider cost data available"
              }
            />
            <MetricCard
              icon={<BarChart3Icon className="size-3.5" />}
              label="Saved turns"
              value={formatCount(events.length)}
              hint="Up to 5,000 recent turns on this device"
            />
          </div>

          <SettingsSection title="Daily activity" className="space-y-0">
            <div className="p-4 sm:p-5">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">Token usage</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Daily totals over the selected period
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatCount(totals.tokens)} tokens
                </span>
              </div>
              <MiniTrend rows={usageRows} />
            </div>
          </SettingsSection>

          <div className="grid gap-4 lg:grid-cols-2">
            <SettingsSection title="Providers" className="space-y-0">
              <div className="space-y-4 p-4 sm:p-5">
                {providerRows.length === 0 ? (
                  <p className="py-5 text-center text-sm text-muted-foreground">
                    No provider usage recorded yet.
                  </p>
                ) : (
                  providerRows.map((row) => (
                    <div key={row.provider} className="space-y-1.5">
                      <div className="flex justify-between gap-3 text-xs">
                        <span className="truncate font-medium">{row.provider}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {formatCount(row.turns)} turns · {formatCount(row.tokens)} tokens
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(3, (row.turns / maxProviderTurns) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </SettingsSection>
            <SettingsSection title="Models" className="space-y-0">
              <div className="space-y-4 p-4 sm:p-5">
                {modelRows.length === 0 ? (
                  <p className="py-5 text-center text-sm text-muted-foreground">
                    No model usage recorded yet.
                  </p>
                ) : (
                  modelRows.map((row) => (
                    <div key={`${row.provider}:${row.model}`} className="space-y-1.5">
                      <div className="flex justify-between gap-3 text-xs">
                        <span className="min-w-0 truncate font-medium">
                          {row.model}
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            {row.provider}
                          </span>
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {formatCount(row.turns)} · {formatCount(row.tokens)} tokens
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/75"
                          style={{ width: `${Math.max(3, (row.turns / maxModelTurns) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </SettingsSection>
          </div>
          <p className="text-xs text-muted-foreground">
            This page reads model-call metadata saved in this browser. Prompts and responses are
            never included.
          </p>
        </>
      )}
    </SettingsPageContainer>
  );
}
