import { useEffect, useMemo, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import {
  readLocalModelAnalyticsEvents,
  type LocalModelUsageEvent,
} from "../../account/modelAnalytics";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { getDisplayModelName, getModelProviderPresentation } from "../chat/providerIconUtils";
import { SettingsPageContainer } from "./settingsLayout";

const WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOWS)[number];
type DailyUsage = {
  readonly date: string;
  readonly turns: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly costEvents: number;
};

type ModelUsage = {
  readonly provider: string;
  readonly model: string;
  readonly turns: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly costEvents: number;
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

function formatFullDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function MiniTrend({
  rows,
  metric,
}: {
  rows: ReadonlyArray<DailyUsage>;
  metric: "tokens" | "cost";
}) {
  const chartRows = metric === "cost" ? rows.filter((row) => row.costEvents > 0) : rows;
  const valueFor = (row: DailyUsage) => (metric === "tokens" ? row.tokens : row.costUsd);
  const max = Math.max(1, ...chartRows.map(valueFor));
  const pointFor = (index: number, value: number) => ({
    x: chartRows.length < 2 ? 50 : 4 + (index / (chartRows.length - 1)) * 92,
    y: 20 + (1 - value / max) * 196,
  });
  const points = chartRows
    .map((row, index) => {
      const { x, y } = pointFor(index, valueFor(row));
      return `${x},${y}`;
    })
    .join(" ");
  if (chartRows.length === 0) {
    return (
      <div className="grid h-44 place-items-center text-sm text-muted-foreground">
        {metric === "cost"
          ? "No cost estimates available in this period."
          : "No usage recorded in this period."}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <svg
        viewBox="0 0 100 240"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Daily ${metric === "tokens" ? "token usage" : "estimated cost"} trend`}
        className="h-56 w-full overflow-visible"
      >
        <defs>
          <linearGradient id="usage-chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" className="[stop-color:var(--color-primary)]" stopOpacity=".12" />
            <stop offset="100%" className="[stop-color:var(--color-primary)]" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[20, 74, 128, 182, 236].map((y) => (
          <line
            key={y}
            x1="0"
            x2="100"
            y1={y}
            y2={y}
            stroke="currentColor"
            strokeWidth="1"
            className="text-border"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polygon points={`0,240 ${points} 100,240`} fill="url(#usage-chart-fill)" />
        <polyline
          points={points}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {chartRows.map((row, index) => {
          const { x, y } = pointFor(index, valueFor(row));
          const label = `${formatFullDate(row.date)}: ${
            metric === "tokens" ? `${formatCount(row.tokens)} tokens` : formatUsd(row.costUsd)
          }`;
          return (
            <g key={row.date} tabIndex={0} role="img" aria-label={label}>
              <circle cx={x} cy={y} r="5" fill="transparent" pointerEvents="all">
                <title>{label}</title>
              </circle>
              <circle cx={x} cy={y} r="1.8" fill="var(--color-primary)" pointerEvents="none" />
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{formatDate(chartRows[0]!.date)}</span>
        <span>{formatDate(chartRows[chartRows.length - 1]!.date)}</span>
      </div>
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
      const current = totalsByDate.get(date) ?? {
        date,
        turns: 0,
        tokens: 0,
        costUsd: 0,
        costEvents: 0,
      };
      totalsByDate.set(date, {
        date,
        turns: current.turns + 1,
        tokens: current.tokens + numberOrZero(event.totalTokens),
        costUsd: current.costUsd + numberOrZero(event.costUsd),
        costEvents: current.costEvents + (event.costUsd === undefined ? 0 : 1),
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
        costUsd: 0,
        costEvents: 0,
      };
      byModel.set(key, {
        ...current,
        turns: current.turns + 1,
        tokens: current.tokens + numberOrZero(event.totalTokens),
        costUsd: current.costUsd + numberOrZero(event.costUsd),
        costEvents: current.costEvents + (event.costUsd === undefined ? 0 : 1),
      });
    }
    return [...byModel.values()].sort((a, b) => b.turns - a.turns || b.tokens - a.tokens);
  }, [periodEvents]);

  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");

  return (
    <SettingsPageContainer className="max-w-5xl gap-6">
      <header className="@container/usage-header flex min-h-12 shrink-0 items-center gap-1 border-b pb-2">
        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-2 @4xl/usage-header:flex">
          <h1 className="min-w-0 truncate text-base font-medium text-foreground">Usage</h1>
          <div className="ms-auto flex shrink-0 items-center justify-end gap-2">
            <ToggleGroup
              aria-label="Usage period"
              variant="segmented"
              value={[String(days)]}
              onValueChange={(next) => {
                const value = next[0];
                if (value && WINDOWS.some((window) => String(window) === value)) {
                  setDays(Number(value) as WindowDays);
                }
              }}
            >
              {WINDOWS.map((window) => (
                <Toggle key={window} value={String(window)}>
                  {window} days
                </Toggle>
              ))}
            </ToggleGroup>
            <ToggleGroup
              aria-label="Usage metric"
              variant="segmented"
              value={[metric]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "tokens" || value === "cost") setMetric(value);
              }}
            >
              <Toggle value="tokens">Tokens</Toggle>
              <Toggle value="cost">Cost</Toggle>
            </ToggleGroup>
            <Button
              onClick={() => setRefreshToken((value) => value + 1)}
              aria-label="Refresh usage"
              aria-busy={loading}
              disabled={loading}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </header>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading usage…</p>
      ) : (
        <div className="flex flex-col gap-6">
          <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-5">
              <div className="flex flex-col gap-1">
                <span className="text-4xl font-semibold text-foreground tabular-nums">
                  {metric === "tokens"
                    ? formatCount(totals.tokens)
                    : totals.costEvents > 0
                      ? formatUsd(totals.cost)
                      : "—"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {metric === "cost"
                    ? `API estimate · ${formatCount(totals.costEvents)} of ${formatCount(
                        totals.turns,
                      )} turns priced`
                    : `${formatCount(totals.turns)} turns`}
                </span>
              </div>

              {modelRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No model usage recorded yet.</p>
              ) : (
                modelRows.map((row) => {
                  const value = metric === "tokens" ? row.tokens : row.costUsd;
                  const share = metric === "tokens" ? totals.tokens : totals.cost;
                  const modelPresentation = getModelProviderPresentation({ slug: row.model });
                  const ModelIcon = modelPresentation?.Icon;
                  return (
                    <div key={`${row.provider}:${row.model}`} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                          {ModelIcon ? <ModelIcon className="size-4 shrink-0" aria-hidden /> : null}
                          <span className="truncate">{getDisplayModelName({ slug: row.model, name: row.model })}</span>
                          <span className="shrink-0 whitespace-nowrap text-2xs text-muted-foreground tabular-nums">
                            {formatCount(row.turns)} turns
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                          {metric === "tokens"
                            ? formatCount(value)
                            : row.costEvents > 0
                              ? formatUsd(value)
                              : "—"}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {metric === "cost" && row.costEvents === 0
                          ? "No published price available"
                          : `${formatPercent(share > 0 ? value / share : 0)} of ${
                              metric === "cost" ? "estimated cost" : "tokens"
                            }`}
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">
                Daily {metric === "tokens" ? "processed tokens" : "cost"}
              </h2>
              <MiniTrend rows={usageRows} metric={metric} />
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-foreground">Totals</h2>
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Turns</span>
                <span className="text-base font-medium text-foreground tabular-nums">
                  {formatCount(totals.turns)}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Processed tokens</span>
                <span className="text-base font-medium text-foreground tabular-nums">
                  {formatCount(totals.tokens)}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Estimated cost</span>
                <span className="text-base font-medium text-foreground tabular-nums">
                  {totals.costEvents > 0 ? formatUsd(totals.cost) : "—"}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Saved turns</span>
                <span className="text-base font-medium text-foreground tabular-nums">
                  {formatCount(events.length)}
                </span>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
              <ToggleGroup
                aria-label="Usage breakdown"
                variant="segmented"
                value={[breakdown]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "model" || value === "time") setBreakdown(value);
                }}
              >
                <Toggle value="model">Model</Toggle>
                <Toggle value="time">Day</Toggle>
              </ToggleGroup>
            </div>

            {breakdown === "model" ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-right text-xs text-muted-foreground">
                    <th className="py-2 pr-3 text-left font-normal">#</th>
                    <th className="w-full py-2 text-left font-normal">Model</th>
                    <th className="py-2 pl-6 font-normal">Turns</th>
                    <th className="py-2 pl-6 font-normal">Cost</th>
                    <th className="py-2 pl-6 font-normal">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {modelRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-muted-foreground">
                        No activity in this window.
                      </td>
                    </tr>
                  ) : (
                    modelRows.map((row, index) => (
                      <tr
                        key={`${row.provider}:${row.model}`}
                        className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50"
                      >
                        <td className="py-2.5 pr-3 text-left text-xs">{index + 1}</td>
                        <td className="py-2.5 text-left whitespace-normal text-foreground">
                          <span className="inline-flex min-w-0 items-center gap-2">
                            {(() => {
                              const ModelIcon = getModelProviderPresentation({ slug: row.model })?.Icon;
                              return ModelIcon ? <ModelIcon className="size-4 shrink-0" aria-hidden /> : null;
                            })()}
                            <span>{getDisplayModelName({ slug: row.model, name: row.model })}</span>
                          </span>
                        </td>
                        <td className="py-2.5 pl-6">{formatCount(row.turns)}</td>
                        <td className="py-2.5 pl-6 text-foreground">
                          {row.costEvents > 0 ? formatUsd(row.costUsd) : "—"}
                        </td>
                        <td className="py-2.5 pl-6">{formatCount(row.tokens)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            ) : (
              <div
                className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                role="region"
                aria-label="Usage breakdown by day"
                tabIndex={0}
              >
                <table className="w-full text-sm whitespace-nowrap">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 font-normal">Day</th>
                      <th className="py-2 pl-4 text-right font-normal">Turns</th>
                      <th className="py-2 pl-4 text-right font-normal">Cost</th>
                      <th className="py-2 pl-4 text-right font-normal">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageRows.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-muted-foreground">
                          No activity in this window.
                        </td>
                      </tr>
                    ) : (
                      [...usageRows].reverse().map((row) => (
                        <tr
                          key={row.date}
                          className="border-b border-border/50 transition-colors hover:bg-muted/50"
                        >
                          <td className="py-2 text-foreground">{formatDate(row.date)}</td>
                          <td className="py-2 pl-4 text-right text-muted-foreground tabular-nums">
                            {formatCount(row.turns)}
                          </td>
                          <td className="py-2 pl-4 text-right text-muted-foreground tabular-nums">
                            {row.costEvents > 0 ? formatUsd(row.costUsd) : "—"}
                          </td>
                          <td className="py-2 pl-4 text-right text-muted-foreground tabular-nums">
                            {formatCount(row.tokens)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="text-xs text-muted-foreground">
            Costs use published API list prices where a matching model rate and token breakdown are
            available. Unsupported models are excluded; subscription charges, discounts, and
            provider billing may differ. Usage metadata is stored on this device. Prompts and
            responses are never included.
          </p>
        </div>
      )}
    </SettingsPageContainer>
  );
}
