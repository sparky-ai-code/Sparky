import { v } from "convex/values";
import { internalMutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";

const ADMIN_EMAIL = "soliamanmagbari@gmail.com";
const sourceValidator = v.union(v.literal("site"), v.literal("app"), v.literal("edge"));
const eventKindValidator = v.union(
  v.literal("page_view"),
  v.literal("heartbeat"),
  v.literal("download"),
  v.literal("download_page_open"),
  v.literal("download_click"),
  v.literal("download_request"),
  v.literal("download_error"),
  v.literal("demo_interaction"),
  v.literal("desktop_render_interaction"),
  v.literal("app_launch"),
  v.literal("model_request"),
);
const visibleKindValidator = v.union(
  v.literal("page_view"),
  v.literal("download"),
  v.literal("download_page_open"),
  v.literal("download_click"),
  v.literal("download_request"),
  v.literal("download_error"),
  v.literal("demo_interaction"),
  v.literal("desktop_render_interaction"),
  v.literal("app_launch"),
  v.literal("model_request"),
);

const metricShape = {
  uniqueVisitors: v.number(),
  sessions: v.number(),
  pageViews: v.number(),
  downloads: v.number(),
  downloadClicks: v.number(),
  downloadPageOpens: v.number(),
  downloadRequests: v.number(),
  downloadErrors: v.number(),
  demoInteractions: v.number(),
  engagedMs: v.number(),
  appUsers: v.number(),
  appLaunches: v.number(),
  modelRequests: v.number(),
};

const eventMetadataArgs = {
  downloadId: v.optional(v.string()),
  requestId: v.optional(v.string()),
  environmentId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  turnId: v.optional(v.string()),
  platform: v.optional(v.string()),
  release: v.optional(v.string()),
  file: v.optional(v.string()),
  outcome: v.optional(v.string()),
  referrer: v.optional(v.string()),
  browser: v.optional(v.string()),
  os: v.optional(v.string()),
  device: v.optional(v.string()),
  country: v.optional(v.string()),
  colo: v.optional(v.string()),
  language: v.optional(v.string()),
  timezone: v.optional(v.string()),
  viewport: v.optional(v.string()),
  status: v.optional(v.number()),
  model: v.optional(v.string()),
  provider: v.optional(v.string()),
  inputTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  reasoningOutputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  toolUses: v.optional(v.number()),
  costUsd: v.optional(v.number()),
};

async function requireAdmin(ctx: Pick<QueryCtx, "auth">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.email?.toLowerCase() !== ADMIN_EMAIL) {
    throw new Error("Administrator access is required.");
  }
}

function utcDate(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isBackgroundUpdatePath(path: string) {
  return path === "/get/updates" || path.startsWith("/get/updates/");
}

function isBackgroundUpdateEvent(event: { source: string; path: string }) {
  return event.source === "edge" && isBackgroundUpdatePath(event.path);
}

async function incrementTotal(ctx: MutationCtx, key: string, amount: number) {
  const current = await ctx.db.query("metricTotals").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (current) await ctx.db.patch(current._id, { value: current.value + amount });
  else await ctx.db.insert("metricTotals", { key, value: amount });
}

async function incrementDaily(ctx: MutationCtx, date: string, increments: Partial<Record<keyof typeof metricShape, number>>) {
  const current = await ctx.db.query("dailyMetrics").withIndex("by_date", (q) => q.eq("date", date)).unique();
  if (!current) {
    await ctx.db.insert("dailyMetrics", {
      date,
      uniqueVisitors: increments.uniqueVisitors ?? 0,
      sessions: increments.sessions ?? 0,
      pageViews: increments.pageViews ?? 0,
      downloads: increments.downloads ?? 0,
      downloadClicks: increments.downloadClicks ?? 0,
      downloadPageOpens: increments.downloadPageOpens ?? 0,
      downloadRequests: increments.downloadRequests ?? 0,
      downloadErrors: increments.downloadErrors ?? 0,
      demoInteractions: increments.demoInteractions ?? 0,
      engagedMs: increments.engagedMs ?? 0,
      appUsers: increments.appUsers ?? 0,
      appLaunches: increments.appLaunches ?? 0,
modelRequests: increments.modelRequests ?? 0,
    });
    return;
  }
  const patch: Record<string, number> = {};
  for (const [key, amount] of Object.entries(increments)) {
    const currentValue = (current as unknown as Record<string, unknown>)[key];
    patch[key] = (Number(currentValue) || 0) + (amount ?? 0);
  }
  await ctx.db.patch(current._id, patch);
}

export const recordEvent = internalMutation({
  args: {
    visitorId: v.string(),
    sessionId: v.string(),
    source: sourceValidator,
    kind: eventKindValidator,
    path: v.string(),
    label: v.optional(v.string()),
    at: v.number(),
    engagedMs: v.optional(v.number()),
    ...eventMetadataArgs,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.source === "edge" && isBackgroundUpdatePath(args.path)) return null;
    const at = Math.min(Date.now() + 60_000, Math.max(0, args.at));
    const date = utcDate(at);
    const daily: Partial<Record<keyof typeof metricShape, number>> = {};
    if (args.kind !== "heartbeat") {
      const duplicate = args.requestId
        ? await ctx.db.query("events").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).first()
        : args.downloadId
          ? await ctx.db.query("events").withIndex("by_download_id_and_kind", (q) => q.eq("downloadId", args.downloadId).eq("kind", args.kind)).first()
          : null;
      if (duplicate) return null;
    }
    const shouldTrackSession = args.source !== "edge";
    const session = shouldTrackSession
      ? await ctx.db.query("sessions").withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId)).unique()
      : null;

    if (shouldTrackSession && !session) {
      await ctx.db.insert("sessions", {
        visitorId: args.visitorId,
        sessionId: args.sessionId,
        source: args.source,
        path: args.path.slice(0, 300),
        startedAt: at,
        lastSeenAt: at,
        engagedMs: 0,
      });
      daily.sessions = 1;
      await incrementTotal(ctx, "sessions", 1);
    } else if (session) {
      await ctx.db.patch(session._id, { lastSeenAt: at, path: args.path.slice(0, 300) });
    }

    if (args.source === "site") {
      const visitor = await ctx.db.query("visitors").withIndex("by_visitor_id", (q) => q.eq("visitorId", args.visitorId)).unique();
      if (!visitor) {
        await ctx.db.insert("visitors", { visitorId: args.visitorId, firstSeenAt: at, lastSeenAt: at });
        daily.uniqueVisitors = 1;
        await incrementTotal(ctx, "uniqueVisitors", 1);
      } else if (at > visitor.lastSeenAt) {
        await ctx.db.patch(visitor._id, { lastSeenAt: at });
      }
    }

    if (args.kind === "heartbeat") {
      const engagedMs = Math.min(Math.max(0, args.engagedMs ?? 0), 30_000);
      if (engagedMs > 0) {
        const latestSession = session ?? (shouldTrackSession
          ? await ctx.db.query("sessions").withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId)).unique()
          : null);
        if (latestSession) await ctx.db.patch(latestSession._id, { engagedMs: latestSession.engagedMs + engagedMs, lastSeenAt: at });
        daily.engagedMs = engagedMs;
        await incrementTotal(ctx, "engagedMs", engagedMs);
      }
    } else {
      await ctx.db.insert("events", {
        visitorId: args.visitorId,
        sessionId: args.sessionId,
        source: args.source,
        kind: args.kind,
        path: args.path.slice(0, 300),
        label: args.label?.slice(0, 200),
        at,
        downloadId: args.downloadId?.slice(0, 100),
        requestId: args.requestId?.slice(0, 100),
        environmentId: args.environmentId?.slice(0, 200),
        threadId: args.threadId?.slice(0, 200),
        turnId: args.turnId?.slice(0, 200),
        platform: args.platform?.slice(0, 80),
        release: args.release?.slice(0, 80),
        file: args.file?.slice(0, 160),
        outcome: args.outcome?.slice(0, 80),
        referrer: args.referrer?.slice(0, 200),
        browser: args.browser?.slice(0, 80),
        os: args.os?.slice(0, 80),
        device: args.device?.slice(0, 80),
        country: args.country?.slice(0, 20),
        colo: args.colo?.slice(0, 20),
        language: args.language?.slice(0, 40),
        timezone: args.timezone?.slice(0, 80),
        viewport: args.viewport?.slice(0, 40),
        status: args.status,
        model: args.model?.slice(0, 200),
        provider: args.provider?.slice(0, 100),
        inputTokens: args.inputTokens,
        cachedInputTokens: args.cachedInputTokens,
        outputTokens: args.outputTokens,
        reasoningOutputTokens: args.reasoningOutputTokens,
        totalTokens: args.totalTokens,
        toolUses: args.toolUses,
        costUsd: args.costUsd,
      });
      const key = args.kind === "page_view" ? "pageViews"
        : args.kind === "download" ? "downloads"
          : args.kind === "download_click" ? "downloadClicks"
            : args.kind === "download_page_open" ? "downloadPageOpens"
              : args.kind === "download_request" ? "downloadRequests"
                : args.kind === "download_error" ? "downloadErrors"
                  : args.kind === "demo_interaction" || args.kind === "desktop_render_interaction" ? "demoInteractions"
                                         : args.kind === "model_request" ? "modelRequests"
                       : "appLaunches";
      daily[key] = 1;
      await incrementTotal(ctx, key, 1);

      if (args.kind === "app_launch") {
        const installation = await ctx.db.query("installations").withIndex("by_installation_id", (q) => q.eq("installationId", args.visitorId)).unique();
        if (!installation) {
          await ctx.db.insert("installations", { installationId: args.visitorId, firstSeenAt: at, lastSeenAt: at });
          daily.appUsers = 1;
          await incrementTotal(ctx, "appUsers", 1);
        } else if (at > installation.lastSeenAt) {
          await ctx.db.patch(installation._id, { lastSeenAt: at });
        }
      }
    }

    await incrementDaily(ctx, date, daily);
    return null;
  },
});

export const repairLegacyUpdaterAnalytics = internalMutation({
  args: {},
  returns: v.object({
    alreadyRepaired: v.boolean(),
    repairedRequests: v.number(),
    repairedErrors: v.number(),
  }),
  handler: async (ctx) => {
    const repairKey = "repair:legacy-updater-analytics:v1";
    const existingRepair = await ctx.db.query("metricTotals").withIndex("by_key", (q) => q.eq("key", repairKey)).unique();
    if (existingRepair) return { alreadyRepaired: true, repairedRequests: 0, repairedErrors: 0 };

    const dailyDeltas = new Map<string, { downloadRequests: number; downloadErrors: number }>();
    let repairedRequests = 0;
    let repairedErrors = 0;
    for (const event of await ctx.db.query("events").collect()) {
      if (!isBackgroundUpdateEvent(event)) continue;
      if (event.kind !== "download_request" && event.kind !== "download_error") continue;
      const delta = dailyDeltas.get(utcDate(event.at)) ?? { downloadRequests: 0, downloadErrors: 0 };
      if (event.kind === "download_request") {
        delta.downloadRequests += 1;
        repairedRequests += 1;
      } else {
        delta.downloadErrors += 1;
        repairedErrors += 1;
      }
      dailyDeltas.set(utcDate(event.at), delta);
    }

    for (const [date, delta] of dailyDeltas) {
      const row = await ctx.db.query("dailyMetrics").withIndex("by_date", (q) => q.eq("date", date)).unique();
      if (!row) continue;
      await ctx.db.patch(row._id, {
        downloadRequests: Math.max(0, (row.downloadRequests ?? 0) - delta.downloadRequests),
        downloadErrors: Math.max(0, (row.downloadErrors ?? 0) - delta.downloadErrors),
      });
    }

    for (const [key, amount] of [["downloadRequests", repairedRequests], ["downloadErrors", repairedErrors]] as const) {
      if (amount === 0) continue;
      const row = await ctx.db.query("metricTotals").withIndex("by_key", (q) => q.eq("key", key)).unique();
      if (row) await ctx.db.patch(row._id, { value: Math.max(0, row.value - amount) });
    }
    await ctx.db.insert("metricTotals", { key: repairKey, value: 1 });
    return { alreadyRepaired: false, repairedRequests, repairedErrors };
  },
});

export const dashboard = query({
  args: {},
  returns: v.object({
    totals: v.object(metricShape),
    daily: v.array(v.object({ date: v.string(), ...metricShape })),
    recent: v.array(v.object({
      kind: visibleKindValidator,
      source: sourceValidator,
      path: v.string(),
      label: v.optional(v.string()),
      at: v.number(),
      downloadId: v.optional(v.string()),
      requestId: v.optional(v.string()),
      platform: v.optional(v.string()),
      release: v.optional(v.string()),
      file: v.optional(v.string()),
      outcome: v.optional(v.string()),
      referrer: v.optional(v.string()),
      browser: v.optional(v.string()),
      os: v.optional(v.string()),
      device: v.optional(v.string()),
      country: v.optional(v.string()),
      colo: v.optional(v.string()),
      status: v.optional(v.number()),
      model: v.optional(v.string()),
      provider: v.optional(v.string()),
      inputTokens: v.optional(v.number()),
      cachedInputTokens: v.optional(v.number()),
      outputTokens: v.optional(v.number()),
      reasoningOutputTokens: v.optional(v.number()),
      totalTokens: v.optional(v.number()),
      toolUses: v.optional(v.number()),
      costUsd: v.optional(v.number()),
    })),
    downloadBreakdown: v.array(v.object({ platform: v.string(), clicks: v.number(), requests: v.number(), errors: v.number() })),
    environmentBreakdown: v.array(v.object({ browser: v.string(), os: v.string(), device: v.string(), visitors: v.number() })),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const totalRows = await ctx.db.query("metricTotals").take(40);
    const totals = {
      uniqueVisitors: 0,
      sessions: 0,
      pageViews: 0,
      downloads: 0,
      downloadClicks: 0,
      downloadPageOpens: 0,
      downloadRequests: 0,
      downloadErrors: 0,
      demoInteractions: 0,
      engagedMs: 0,
      appUsers: 0,
      appLaunches: 0,
modelRequests: 0,
    };
    for (const row of totalRows) {
      if (row.key in totals) totals[row.key as keyof typeof totals] = row.value;
    }

    const daily = (await ctx.db.query("dailyMetrics").order("desc").take(30))
      .reverse()
      .map(({ date, uniqueVisitors, sessions, pageViews, downloads, downloadClicks, downloadPageOpens, downloadRequests, downloadErrors, demoInteractions, engagedMs, appUsers, appLaunches, modelRequests }) => ({
        date,
        uniqueVisitors: uniqueVisitors ?? 0,
        sessions: sessions ?? 0,
        pageViews: pageViews ?? 0,
        downloads: downloads ?? 0,
        downloadClicks: downloadClicks ?? 0,
        downloadPageOpens: downloadPageOpens ?? 0,
        downloadRequests: downloadRequests ?? 0,
        downloadErrors: downloadErrors ?? 0,
        demoInteractions: demoInteractions ?? 0,
        engagedMs: engagedMs ?? 0,
        appUsers: appUsers ?? 0,
        appLaunches: appLaunches ?? 0,
modelRequests: modelRequests ?? 0,
      }));

    const events = await ctx.db.query("events").order("desc").take(5000);
    const visibleEvents = events.filter((event) => !isBackgroundUpdateEvent(event));
    const recent = visibleEvents
      .filter((event): event is typeof event & { kind: Exclude<typeof event.kind, "heartbeat"> } => event.kind !== "heartbeat")
      .slice(0, 24)
      .map(({ kind, source, path, label, at, downloadId, requestId, platform, release, file, outcome, referrer, browser, os, device, country, colo, status, model, provider, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens, toolUses, costUsd }) => ({
        kind,
        source,
        path,
        label,
        at,
        downloadId,
        requestId,
        platform,
        release,
        file,
        outcome,
        referrer,
        browser,
        os,
        device,
        country,
        colo,
        status,
        model,
        provider,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens,
        toolUses,
        costUsd,
      }));

    const downloadGroups = new Map<string, { platform: string; clicks: number; requests: number; errors: number }>();
    for (const event of visibleEvents) {
      const isClick = event.kind === "download" || event.kind === "download_click";
      const isRequest = event.kind === "download_request";
      const isError = event.kind === "download_error";
      if (!isClick && !isRequest && !isError) continue;
      const platform = event.platform || "unknown";
      const row = downloadGroups.get(platform) ?? { platform, clicks: 0, requests: 0, errors: 0 };
      if (isClick) row.clicks += 1;
      if (isRequest) row.requests += 1;
      if (isError) row.errors += 1;
      downloadGroups.set(platform, row);
    }
    const downloadBreakdown = [...downloadGroups.values()]
      .sort((a, b) => (b.clicks + b.requests) - (a.clicks + a.requests))
      .slice(0, 8);

    const environmentGroups = new Map<string, { browser: string; os: string; device: string; visitors: Set<string> }>();
    for (const event of events) {
      if (event.source !== "site" || event.kind !== "page_view") continue;
      const browser = event.browser || "unknown";
      const os = event.os || "unknown";
      const device = event.device || "unknown";
      const key = `${browser}|${os}|${device}`;
      const row = environmentGroups.get(key) ?? { browser, os, device, visitors: new Set<string>() };
      row.visitors.add(event.visitorId);
      environmentGroups.set(key, row);
    }
    const environmentBreakdown = [...environmentGroups.values()]
      .map(({ browser, os, device, visitors }) => ({ browser, os, device, visitors: visitors.size }))
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, 8);

    return { totals, daily, recent, downloadBreakdown, environmentBreakdown };
  },
});
