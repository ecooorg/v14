BEGIN;
CREATE TABLE IF NOT EXISTS budgets (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('project','task','run')),
  scope_id text NOT NULL,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, scope, scope_id)
);
-- No 'autonomous' mode exists and no flag to enable it (TZ 8.6).
CREATE TABLE IF NOT EXISTS project_settings (
  project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  approval_mode text NOT NULL DEFAULT 'supervised' CHECK (approval_mode IN ('supervised','manual')),
  max_concurrent_runs integer NOT NULL DEFAULT 2 CHECK (max_concurrent_runs BETWEEN 1 AND 10),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plans (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
  source text NOT NULL CHECK (source IN ('template','model','human')),
  template text,
  nodes jsonb NOT NULL,
  total_units integer NOT NULL DEFAULT 0 CHECK (total_units >= 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (project_id, version)
);
CREATE TABLE IF NOT EXISTS plan_tasks (
  plan_id text NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  node_key text NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, node_key),
  UNIQUE (task_id)
);
CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  seq bigserial NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('plan','budget','merge_ready','state_decision','destructive','task_start')),
  subject_id text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text NOT NULL,
  decided_by text,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS approvals_project_status_idx ON approvals(project_id, status, seq);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_idx ON approvals(project_id, kind, subject_id) WHERE status = 'PENDING';
COMMIT;
