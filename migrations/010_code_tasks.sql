BEGIN;
-- P18 / BX-21.a: one row per CodeExecutor run for a task (TZ 11.4). No vendor or model names in the schema (D-13).
CREATE TABLE IF NOT EXISTS code_tasks (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id text,
  attempt integer NOT NULL CHECK (attempt >= 1),
  executor text NOT NULL CHECK (executor IN ('manual','model_patch')),
  status text NOT NULL CHECK (status IN ('WAITING_HUMAN','RUNNING','DELIVERED','FAILED','BLOCKED')),
  delivery text CHECK (delivery IS NULL OR delivery IN ('pr','branch','diff')),
  base_branch text NOT NULL CHECK (base_branch ~ '^[A-Za-z0-9._/-]{1,100}$'),
  branch text CHECK (branch IS NULL OR branch ~ '^biforge/[A-Za-z0-9_-]{1,128}$'),
  head_sha text CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  pr_number integer CHECK (pr_number IS NULL OR pr_number >= 1),
  pr_url text CHECK (pr_url IS NULL OR pr_url ~ '^https://'),
  executor_note text CHECK (executor_note IS NULL OR length(executor_note) <= 500),
  files_changed integer CHECK (files_changed IS NULL OR files_changed >= 0),
  lines_changed integer CHECK (lines_changed IS NULL OR lines_changed >= 0),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  package_hash text NOT NULL CHECK (package_hash ~ '^[0-9a-f]{64}$'),
  package jsonb NOT NULL,
  package_artifact_id text,
  package_artifact_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt),
  CHECK (status <> 'DELIVERED' OR (branch IS NOT NULL AND head_sha IS NOT NULL AND files_changed IS NOT NULL AND lines_changed IS NOT NULL)),
  CHECK (status NOT IN ('BLOCKED','FAILED') OR status_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS code_tasks_project_idx ON code_tasks(project_id, created_at);
-- At most one live (waiting or running) executor run per task: a second start cannot race past this.
CREATE UNIQUE INDEX IF NOT EXISTS code_tasks_one_active_idx ON code_tasks(task_id) WHERE status IN ('WAITING_HUMAN','RUNNING');
COMMIT;
