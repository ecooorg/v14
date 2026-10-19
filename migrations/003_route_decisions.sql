BEGIN;
CREATE TABLE IF NOT EXISTS route_decisions (
  id text PRIMARY KEY,
  run_id text,
  policy_version text NOT NULL,
  sensitivity text NOT NULL DEFAULT 'normal',
  status text NOT NULL,
  reason text,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  rejected jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  units_spent integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_decisions_run_idx ON route_decisions(run_id);
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS units integer NOT NULL DEFAULT 0;
COMMIT;
