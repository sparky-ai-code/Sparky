import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const source = v.union(v.literal("site"), v.literal("app"), v.literal("edge"));
const eventKind = v.union(
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
const channel = v.union(v.literal("release"), v.literal("beta"));
const releaseStatus = v.union(v.literal("draft"), v.literal("published"));
const releasePlatform = v.union(
  v.literal("windows-x64"),
  v.literal("macos-arm64"),
  v.literal("macos-x64"),
  v.literal("linux-x64"),
);
const releaseChunk = v.object({
  storageId: v.id("_storage"),
  size: v.number(),
});
const releaseFile = v.object({
  name: v.string(),
  size: v.number(),
  contentType: v.string(),
  platform: v.optional(releasePlatform),
  awsKey: v.optional(v.string()),
  publicUrl: v.optional(v.string()),
  sha256: v.optional(v.string()),
  uploaded: v.boolean(),
  chunks: v.array(releaseChunk),
});

export default defineSchema({
  events: defineTable({
    visitorId: v.string(),
    sessionId: v.string(),
    source,
    kind: eventKind,
    path: v.string(),
    label: v.optional(v.string()),
    at: v.number(),
    engagedMs: v.optional(v.number()),
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
  })
    .index("by_session_id", ["sessionId"])
    .index("by_at", ["at"])
    .index("by_session_id_and_at", ["sessionId", "at"])
    .index("by_kind_and_at", ["kind", "at"])
    .index("by_download_id_and_kind", ["downloadId", "kind"])
    .index("by_request_id", ["requestId"]),
  sessions: defineTable({
    visitorId: v.string(),
    sessionId: v.string(),
    source,
    path: v.string(),
    startedAt: v.number(),
    lastSeenAt: v.number(),
    engagedMs: v.number(),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_visitor_id", ["visitorId"])
    .index("by_started_at", ["startedAt"]),
  visitors: defineTable({
    visitorId: v.string(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
  }).index("by_visitor_id", ["visitorId"]),
  installations: defineTable({
    installationId: v.string(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
  }).index("by_installation_id", ["installationId"]),
  dailyMetrics: defineTable({
    date: v.string(),
    uniqueVisitors: v.number(),
    sessions: v.number(),
    pageViews: v.number(),
    downloads: v.number(),
    downloadClicks: v.optional(v.number()),
    downloadPageOpens: v.optional(v.number()),
    downloadRequests: v.optional(v.number()),
    downloadErrors: v.optional(v.number()),
    demoInteractions: v.number(),
    engagedMs: v.number(),
    appUsers: v.number(),
    appLaunches: v.number(),
    modelRequests: v.optional(v.number()),
  }).index("by_date", ["date"]),
  metricTotals: defineTable({
    key: v.string(),
    value: v.number(),
  }).index("by_key", ["key"]),
  releases: defineTable({
    tag: v.string(),
    name: v.string(),
    channel,
    status: releaseStatus,
    changelog: v.string(),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
    files: v.array(releaseFile),
  })
    .index("by_tag", ["tag"])
    .index("by_status", ["status"])
    .index("by_channel_and_status", ["channel", "status"]),
  releasePointers: defineTable({
    channel,
    releaseId: v.id("releases"),
    updatedAt: v.number(),
  }).index("by_channel", ["channel"]),
});
