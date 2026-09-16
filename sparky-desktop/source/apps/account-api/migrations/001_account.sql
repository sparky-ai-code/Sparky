CREATE TABLE IF NOT EXISTS sparky_account_profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sparky_account_devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT,
  device_type TEXT NOT NULL DEFAULT 'unknown',
  platform TEXT,
  os_version TEXT,
  app_version TEXT,
  browser TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sparky_account_devices_user_idx
  ON sparky_account_devices(user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS sparky_account_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  issued_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sparky_account_sessions_user_idx
  ON sparky_account_sessions(user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS sparky_account_usage_events (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  device_id TEXT,
  environment_id TEXT,
  thread_id TEXT,
  turn_id TEXT,
  provider TEXT,
  provider_instance_id TEXT,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  tool_uses BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(20, 8),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS sparky_account_usage_events_user_idx
  ON sparky_account_usage_events(user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS sparky_account_usage_daily (
  user_id TEXT NOT NULL,
  usage_date DATE NOT NULL,
  turn_count BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  tool_uses BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

CREATE TABLE IF NOT EXISTS sparky_account_usage_models (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'unknown',
  model TEXT NOT NULL,
  turn_count BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, provider, model)
);

CREATE TABLE IF NOT EXISTS sparky_account_stats (
  user_id TEXT PRIMARY KEY,
  total_turns BIGINT NOT NULL DEFAULT 0,
  total_threads BIGINT NOT NULL DEFAULT 0,
  total_input_tokens BIGINT NOT NULL DEFAULT 0,
  total_cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_reasoning_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  total_tool_uses BIGINT NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  most_used_provider TEXT,
  most_used_model TEXT,
  last_active_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
