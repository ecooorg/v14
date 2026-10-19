BEGIN;
-- P15a / BX-27.a: read-only provider monitoring snapshots (Appendix G S1–S2).
-- No secrets; model ids and header summaries only. Retention follows ADR-08 / ADR-11.

CREATE TABLE IF NOT EXISTS provider_snapshots (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('OK', 'DRIFT', 'FAIL', 'NOT_RUN', 'BLOCKED')),
  model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  rate_limit_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS provider_snapshots_provider_checked_idx
  ON provider_snapshots(provider_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS monitor_alerts (
  id text PRIMARY KEY,
  alert_key text NOT NULL,
  level text NOT NULL CHECK (level IN ('info', 'warn', 'critical')),
  provider_id text,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (alert_key)
);
CREATE INDEX IF NOT EXISTS monitor_alerts_open_idx
  ON monitor_alerts(opened_at DESC) WHERE closed_at IS NULL;

INSERT INTO schema_migrations(version) VALUES ('014_provider_snapshots') ON CONFLICT DO NOTHING;
COMMIT;
