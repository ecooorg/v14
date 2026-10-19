BEGIN;
-- P17 / BX-20: evidence registered by the Gate Engine (TZ 12.3). One row per check result bound to a commit SHA.
CREATE TABLE IF NOT EXISTS gate_evidence (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gate text NOT NULL CHECK (gate IN ('requirements','spec','build','test','test_integrity','security','review','release_candidate')),
  check_name text NOT NULL CHECK (length(check_name) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('PASS','FAIL','BLOCKED','NOT_RUN','REAL_ONLY')),
  rules_version text NOT NULL,
  source text NOT NULL CHECK (source IN ('ci','diff','approval','system')),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 300),
  tool text NOT NULL,
  tool_version text,
  exit_code integer,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  log_url text CHECK (log_url IS NULL OR log_url ~ '^https://'),
  artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  invalidated_at timestamptz,
  invalidated_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((invalidated_at IS NULL) = (invalidated_reason IS NULL)),
  UNIQUE (task_id, source, source_ref)   -- a redelivered webhook never duplicates evidence
);
CREATE INDEX IF NOT EXISTS gate_evidence_task_idx ON gate_evidence(task_id, commit_sha, gate);
-- A human waiver (TZ 12.2): reason and actor are mandatory; bound to one commit; never edited.
CREATE TABLE IF NOT EXISTS gate_waivers (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gate text NOT NULL CHECK (gate IN ('requirements','spec','build','test','test_integrity','security','review','release_candidate')),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, gate, commit_sha)
);
-- Last commit seen for a task branch: a different SHA invalidates earlier evidence (TZ 12.5).
CREATE TABLE IF NOT EXISTS task_heads (
  task_id text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  pr_number integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
