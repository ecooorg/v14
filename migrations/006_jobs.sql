BEGIN;
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  seq bigserial NOT NULL,
  run_id text NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','LEASED','DONE','ABANDONED','CANCELLED')),
  available_at timestamptz NOT NULL DEFAULT now(),
  claims integer NOT NULL DEFAULT 0 CHECK (claims >= 0),
  lease_owner text,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, available_at, seq);
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(status, lease_until);
COMMIT;
