BEGIN;
CREATE TABLE IF NOT EXISTS model_health (
  key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('model','provider')),
  successes integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  avg_latency_ms double precision,
  last_error_class text,
  cooldown_until bigint,
  disabled_at bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_ledger_run_idx ON usage_ledger(run_id);
COMMIT;
