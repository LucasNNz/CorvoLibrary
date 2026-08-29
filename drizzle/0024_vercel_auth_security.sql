CREATE TABLE IF NOT EXISTS auth_rate_limits (
  fingerprint text PRIMARY KEY NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  window_started_at integer NOT NULL,
  blocked_until integer NOT NULL DEFAULT 0,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_blocked_idx ON auth_rate_limits(blocked_until, updated_at);
