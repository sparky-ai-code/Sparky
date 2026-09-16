// @effect-diagnostics nodeBuiltinImport:off
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

import type { AccountApiConfig } from "./config.ts";
import type { AccountPrincipal } from "./auth.ts";

export interface AccountProfile {
  readonly userId: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccountStats {
  readonly totalTurns: number;
  readonly totalThreads: number;
  readonly totalInputTokens: number;
  readonly totalCachedInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalReasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly totalToolUses: number;
  readonly totalCostUsd: string;
  readonly mostUsedProvider: string | null;
  readonly mostUsedModel: string | null;
  readonly lastActiveAt: string | null;
}

export interface AccountDevice {
  readonly deviceId: string;
  readonly label: string | null;
  readonly deviceType: string;
  readonly platform: string | null;
  readonly osVersion: string | null;
  readonly appVersion: string | null;
  readonly browser: string | null;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
}

export interface AccountSession {
  readonly sessionId: string;
  readonly deviceId: string | null;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
}

export interface AccountSnapshot {
  readonly profile: AccountProfile;
  readonly stats: AccountStats;
  readonly devices: ReadonlyArray<AccountDevice>;
  readonly sessions: ReadonlyArray<AccountSession>;
}

export interface AccountDeviceInput {
  readonly deviceId: string;
  readonly label?: string;
  readonly deviceType?: string;
  readonly platform?: string;
  readonly osVersion?: string;
  readonly appVersion?: string;
  readonly browser?: string;
}

export interface UsageEventInput {
  readonly eventId: string;
  readonly deviceId?: string;
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly provider?: string;
  readonly providerInstanceId?: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
  readonly toolUses?: number;
  readonly costUsd?: number;
  readonly occurredAt: string;
}

export function createAccountDatabase(config: AccountApiConfig) {
  const sql = neon(config.databaseUrl);
  const migrate = async (): Promise<void> => {
    const schemaSql = readFileSync(new URL("../migrations/001_account.sql", import.meta.url), "utf8");
    await sql.unsafe(schemaSql);
  };

  const ensureAccount = async (userId: string): Promise<void> => {
    await sql.transaction([
      sql`
        INSERT INTO sparky_account_profiles (user_id)
        VALUES (${userId})
        ON CONFLICT (user_id) DO NOTHING
      `,
      sql`
        INSERT INTO sparky_account_stats (user_id)
        VALUES (${userId})
        ON CONFLICT (user_id) DO NOTHING
      `,
    ]);
  };

  const touchSession = async (principal: AccountPrincipal): Promise<void> => {
    if (!principal.sessionId) return;
    await sql`
      INSERT INTO sparky_account_sessions (
        session_id,
        user_id,
        issued_at,
        expires_at,
        last_seen_at
      )
      VALUES (
        ${principal.sessionId},
        ${principal.userId},
        ${principal.issuedAt?.toISOString() ?? null},
        ${principal.expiresAt?.toISOString() ?? null},
        now()
      )
      ON CONFLICT (session_id) DO UPDATE SET
        user_id = excluded.user_id,
        issued_at = COALESCE(excluded.issued_at, sparky_account_sessions.issued_at),
        expires_at = COALESCE(excluded.expires_at, sparky_account_sessions.expires_at),
        last_seen_at = now(),
        revoked_at = NULL
    `;
  };

  const getAccount = async (userId: string): Promise<AccountSnapshot> => {
    await ensureAccount(userId);
    const [profileRows, statsRows, deviceRows, sessionRows, threadRows] = await Promise.all([
      sql`
        SELECT
          user_id AS "userId",
          display_name AS "displayName",
          avatar_url AS "avatarUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM sparky_account_profiles
        WHERE user_id = ${userId}
      `,
      sql`
        SELECT
          total_turns AS "totalTurns",
          total_threads AS "totalThreads",
          total_input_tokens AS "totalInputTokens",
          total_cached_input_tokens AS "totalCachedInputTokens",
          total_output_tokens AS "totalOutputTokens",
          total_reasoning_output_tokens AS "totalReasoningOutputTokens",
          total_tokens AS "totalTokens",
          total_tool_uses AS "totalToolUses",
          total_cost_usd AS "totalCostUsd",
          most_used_provider AS "mostUsedProvider",
          most_used_model AS "mostUsedModel",
          last_active_at AS "lastActiveAt"
        FROM sparky_account_stats
        WHERE user_id = ${userId}
      `,
      sql`
        SELECT
          device_id AS "deviceId",
          label,
          device_type AS "deviceType",
          platform,
          os_version AS "osVersion",
          app_version AS "appVersion",
          browser,
          last_seen_at AS "lastSeenAt",
          revoked_at AS "revokedAt"
        FROM sparky_account_devices
        WHERE user_id = ${userId}
        ORDER BY last_seen_at DESC
      `,
      sql`
        SELECT
          session_id AS "sessionId",
          device_id AS "deviceId",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_seen_at AS "lastSeenAt",
          revoked_at AS "revokedAt"
        FROM sparky_account_sessions
        WHERE user_id = ${userId}
        ORDER BY last_seen_at DESC
      `,
      sql`
        SELECT COUNT(DISTINCT thread_id)::int AS "totalThreads"
        FROM sparky_account_usage_events
        WHERE user_id = ${userId} AND thread_id IS NOT NULL
      `,
    ]);

    const profile = profileRows[0];
    const stats = statsRows[0];
    if (!profile || !stats) {
      throw new Error("Account profile initialization failed.");
    }

    const mostUsedModelRows = await sql`
      SELECT provider, model
      FROM sparky_account_usage_models
      WHERE user_id = ${userId}
      ORDER BY turn_count DESC, total_tokens DESC, last_used_at DESC
      LIMIT 1
    `;
    const mostUsedModel = mostUsedModelRows[0];

    return {
      profile: {
        userId: String(profile.userId),
        displayName: nullableString(profile.displayName),
        avatarUrl: nullableString(profile.avatarUrl),
        createdAt: String(profile.createdAt),
        updatedAt: String(profile.updatedAt),
      },
      stats: {
        totalTurns: toCount(stats.totalTurns),
        totalThreads: toCount(threadRows[0]?.totalThreads),
        totalInputTokens: toCount(stats.totalInputTokens),
        totalCachedInputTokens: toCount(stats.totalCachedInputTokens),
        totalOutputTokens: toCount(stats.totalOutputTokens),
        totalReasoningOutputTokens: toCount(stats.totalReasoningOutputTokens),
        totalTokens: toCount(stats.totalTokens),
        totalToolUses: toCount(stats.totalToolUses),
        totalCostUsd: String(stats.totalCostUsd ?? "0"),
        mostUsedProvider: nullableString(mostUsedModel?.provider),
        mostUsedModel: nullableString(mostUsedModel?.model),
        lastActiveAt: nullableString(stats.lastActiveAt),
      },
      devices: deviceRows.map((row) => ({
        deviceId: String(row.deviceId),
        label: nullableString(row.label),
        deviceType: String(row.deviceType),
        platform: nullableString(row.platform),
        osVersion: nullableString(row.osVersion),
        appVersion: nullableString(row.appVersion),
        browser: nullableString(row.browser),
        lastSeenAt: String(row.lastSeenAt),
        revokedAt: nullableString(row.revokedAt),
      })),
      sessions: sessionRows.map((row) => ({
        sessionId: String(row.sessionId),
        deviceId: nullableString(row.deviceId),
        issuedAt: nullableString(row.issuedAt),
        expiresAt: nullableString(row.expiresAt),
        lastSeenAt: String(row.lastSeenAt),
        revokedAt: nullableString(row.revokedAt),
      })),
    };
  };

  const updateProfile = async (
    userId: string,
    input: { readonly displayName?: string | null; readonly avatarUrl?: string | null },
  ): Promise<void> => {
    await ensureAccount(userId);
    await sql`
      UPDATE sparky_account_profiles
      SET
        display_name = COALESCE(${input.displayName ?? null}, display_name),
        avatar_url = COALESCE(${input.avatarUrl ?? null}, avatar_url),
        updated_at = now()
      WHERE user_id = ${userId}
    `;
  };

  const upsertDevice = async (userId: string, input: AccountDeviceInput): Promise<void> => {
    await ensureAccount(userId);
    await sql`
      INSERT INTO sparky_account_devices (
        device_id,
        user_id,
        label,
        device_type,
        platform,
        os_version,
        app_version,
        browser,
        last_seen_at
      )
      VALUES (
        ${input.deviceId},
        ${userId},
        ${input.label ?? null},
        ${input.deviceType ?? "unknown"},
        ${input.platform ?? null},
        ${input.osVersion ?? null},
        ${input.appVersion ?? null},
        ${input.browser ?? null},
        now()
      )
      ON CONFLICT (device_id) DO UPDATE SET
        user_id = excluded.user_id,
        label = COALESCE(excluded.label, sparky_account_devices.label),
        device_type = excluded.device_type,
        platform = COALESCE(excluded.platform, sparky_account_devices.platform),
        os_version = COALESCE(excluded.os_version, sparky_account_devices.os_version),
        app_version = COALESCE(excluded.app_version, sparky_account_devices.app_version),
        browser = COALESCE(excluded.browser, sparky_account_devices.browser),
        last_seen_at = now(),
        revoked_at = NULL
    `;
  };

  const recordUsageEvent = async (userId: string, input: UsageEventInput): Promise<boolean> => {
    const provider = input.provider?.trim() || "unknown";
    const model = input.model.trim();
    if (!input.eventId.trim() || !model) {
      throw new Error("Usage event ID and model are required.");
    }

    const values = {
      inputTokens: nonNegativeCount(input.inputTokens),
      cachedInputTokens: nonNegativeCount(input.cachedInputTokens),
      outputTokens: nonNegativeCount(input.outputTokens),
      reasoningOutputTokens: nonNegativeCount(input.reasoningOutputTokens),
      totalTokens: nonNegativeCount(input.totalTokens),
      toolUses: nonNegativeCount(input.toolUses),
      costUsd: input.costUsd === undefined ? null : Math.max(0, input.costUsd),
    };

    await ensureAccount(userId);
    const inserted = await sql`
      WITH inserted_event AS (
        INSERT INTO sparky_account_usage_events (
          user_id,
          event_id,
          device_id,
          environment_id,
          thread_id,
          turn_id,
          provider,
          provider_instance_id,
          model,
          input_tokens,
          cached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          tool_uses,
          cost_usd,
          occurred_at
        )
        VALUES (
          ${userId},
          ${input.eventId.trim()},
          ${input.deviceId ?? null},
          ${input.environmentId ?? null},
          ${input.threadId ?? null},
          ${input.turnId ?? null},
          ${provider},
          ${input.providerInstanceId ?? null},
          ${model},
          ${values.inputTokens},
          ${values.cachedInputTokens},
          ${values.outputTokens},
          ${values.reasoningOutputTokens},
          ${values.totalTokens},
          ${values.toolUses},
          ${values.costUsd},
          ${input.occurredAt}
        )
        ON CONFLICT (user_id, event_id) DO NOTHING
        RETURNING *
      ),
      daily AS (
        INSERT INTO sparky_account_usage_daily (
          user_id,
          usage_date,
          turn_count,
          input_tokens,
          cached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          tool_uses,
          cost_usd
        )
        SELECT
          user_id,
          occurred_at::date,
          1,
          input_tokens,
          cached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          tool_uses,
          COALESCE(cost_usd, 0)
        FROM inserted_event
        ON CONFLICT (user_id, usage_date) DO UPDATE SET
          turn_count = sparky_account_usage_daily.turn_count + EXCLUDED.turn_count,
          input_tokens = sparky_account_usage_daily.input_tokens + EXCLUDED.input_tokens,
          cached_input_tokens = sparky_account_usage_daily.cached_input_tokens + EXCLUDED.cached_input_tokens,
          output_tokens = sparky_account_usage_daily.output_tokens + EXCLUDED.output_tokens,
          reasoning_output_tokens = sparky_account_usage_daily.reasoning_output_tokens + EXCLUDED.reasoning_output_tokens,
          total_tokens = sparky_account_usage_daily.total_tokens + EXCLUDED.total_tokens,
          tool_uses = sparky_account_usage_daily.tool_uses + EXCLUDED.tool_uses,
          cost_usd = sparky_account_usage_daily.cost_usd + EXCLUDED.cost_usd
      ),
      models AS (
        INSERT INTO sparky_account_usage_models (
          user_id,
          provider,
          model,
          turn_count,
          total_tokens,
          last_used_at
        )
        SELECT user_id, provider, model, 1, total_tokens, occurred_at
        FROM inserted_event
        ON CONFLICT (user_id, provider, model) DO UPDATE SET
          turn_count = sparky_account_usage_models.turn_count + EXCLUDED.turn_count,
          total_tokens = sparky_account_usage_models.total_tokens + EXCLUDED.total_tokens,
          last_used_at = GREATEST(sparky_account_usage_models.last_used_at, EXCLUDED.last_used_at)
      ),
      stats AS (
        INSERT INTO sparky_account_stats (
          user_id,
          total_turns,
          total_input_tokens,
          total_cached_input_tokens,
          total_output_tokens,
          total_reasoning_output_tokens,
          total_tokens,
          total_tool_uses,
          total_cost_usd,
          last_active_at,
          updated_at
        )
        SELECT
          user_id,
          1,
          input_tokens,
          cached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          tool_uses,
          COALESCE(cost_usd, 0),
          occurred_at,
          now()
        FROM inserted_event
        ON CONFLICT (user_id) DO UPDATE SET
          total_turns = sparky_account_stats.total_turns + EXCLUDED.total_turns,
          total_input_tokens = sparky_account_stats.total_input_tokens + EXCLUDED.total_input_tokens,
          total_cached_input_tokens = sparky_account_stats.total_cached_input_tokens + EXCLUDED.total_cached_input_tokens,
          total_output_tokens = sparky_account_stats.total_output_tokens + EXCLUDED.total_output_tokens,
          total_reasoning_output_tokens = sparky_account_stats.total_reasoning_output_tokens + EXCLUDED.total_reasoning_output_tokens,
          total_tokens = sparky_account_stats.total_tokens + EXCLUDED.total_tokens,
          total_tool_uses = sparky_account_stats.total_tool_uses + EXCLUDED.total_tool_uses,
          total_cost_usd = sparky_account_stats.total_cost_usd + EXCLUDED.total_cost_usd,
          last_active_at = GREATEST(sparky_account_stats.last_active_at, EXCLUDED.last_active_at),
          updated_at = now()
      )
      SELECT COUNT(*)::int AS "insertedCount" FROM inserted_event
    `;

    return toCount(inserted[0]?.insertedCount) > 0;
  };

  return {
    migrate,
    ensureAccount,
    touchSession,
    getAccount,
    updateProfile,
    upsertDevice,
    recordUsageEvent,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function nonNegativeCount(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.floor(value));
}
