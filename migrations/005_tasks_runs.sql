BEGIN;
CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  input jsonb NOT NULL,
  input_fingerprint text NOT NULL CHECK (length(input_fingerprint) = 64),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','READY','QUEUED','RUNNING','VALIDATING','PASS','FAIL','BLOCKED','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  blocked_reason text,
  validated_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS tasks_project_state_idx ON tasks(project_id, state);
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt >= 1),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','ABANDONED')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  input_fingerprint text NOT NULL,
  input_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  profile text,
  profile_version text,
  provider_id text,
  model_id text,
  policy_version text,
  budget jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (task_id, attempt),
  UNIQUE (task_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS runs_project_status_idx ON runs(project_id, status);
CREATE TABLE IF NOT EXISTS task_events (
  id text PRIMARY KEY,
  seq bigserial NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id text,
  event_type text NOT NULL,
  from_state text,
  to_state text,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_events_task_seq_idx ON task_events(task_id, seq);
COMMIT;
