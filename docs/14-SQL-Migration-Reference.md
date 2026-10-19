# 14. SQL Migration Reference

Verbatim SQL from the source archive. The migration files in the application repository remain executable truth; this snapshot is included for review/reconstruction and is not intended to be applied independently.

## `001_project_state.sql`

SHA-256: `658f4a4d1b4a68f4f06b0e339661d2d528e9d36cae8f6c1892bf3e8b98a04cde`

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_states (
  project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_state_versions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state_version integer NOT NULL CHECK (state_version >= 1),
  state jsonb NOT NULL,
  actor text NOT NULL CHECK (actor IN ('human','agent','tool','system')),
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, state_version)
);
CREATE INDEX IF NOT EXISTS project_state_versions_project_created_idx ON project_state_versions(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS project_events (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL CHECK (actor IN ('human','agent','tool','system')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_events_project_created_idx ON project_events(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  project_id text REFERENCES projects(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES ('001_project_state') ON CONFLICT DO NOTHING;
COMMIT;
```

## `002_artifacts_ledger.sql`

SHA-256: `e7f856dabca986800e1ae32afd8c7d8e0945a482b909cdf1d9911daaf76df5d2`

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  artifact_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 5242880),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  created_by text NOT NULL,
  derived_from jsonb NOT NULL DEFAULT '[]'::jsonb,
  security_status text NOT NULL DEFAULT 'unchecked',
  classification text NOT NULL DEFAULT 'unclassified',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(artifact_id, version)
);
CREATE INDEX IF NOT EXISTS artifacts_project_idx ON artifacts(project_id, artifact_id, version DESC);
CREATE TABLE IF NOT EXISTS usage_ledger (
  id text PRIMARY KEY,
  run_id text,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  cached_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  retries integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  error_class text,
  cost_estimate numeric,
  route_decision_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_ledger_created_idx ON usage_ledger(created_at DESC);
CREATE TABLE IF NOT EXISTS connection_checks (
  id text PRIMARY KEY,
  connector text NOT NULL,
  check_id text NOT NULL,
  status text NOT NULL,
  reason text,
  http_status integer,
  latency_ms integer,
  checked_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
```

## `003_route_decisions.sql`

SHA-256: `adbc65edefaae5513bdc1177d58273b1fff8090bc851d1b4ff556a3f25189831`

```sql
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
```

## `004_model_health.sql`

SHA-256: `f3eec55a9a70ec55c88f31b87e84533cc3c11276e6c4c9fea0c0b1b8e80e6404`

```sql
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
```

## `005_tasks_runs.sql`

SHA-256: `66ad39735e7db86b25fc7b308d1741efd0d47aefd92ab1eac9bf57d6898417cc`

```sql
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
```

## `006_jobs.sql`

SHA-256: `fd8c06da7df752f6461a8acf5bd45599065978ed0c565cb9c30c3be38cc092ca`

```sql
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
```

## `007_budgets_plans_approvals.sql`

SHA-256: `9320cb699f0ec5776df56da46c29d0e1baf2deb52f010bb3eed4e5257225b696`

```sql
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
```

## `008_artifact_manifests.sql`

SHA-256: `661f5081d060de7024d5a1c5bcde744a10a7071f33e900a46737b12177ddf498`

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS artifact_manifests (
  artifact_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  size integer NOT NULL CHECK (size >= 0 AND size <= 5242880),
  storage_ref text NOT NULL,
  mime text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text', 'binary', 'archive', 'executable')),
  manifest jsonb NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, version)
);
CREATE INDEX IF NOT EXISTS artifact_manifests_project_idx ON artifact_manifests(project_id, artifact_id, version DESC);
-- Versions stored before this migration (P04, P06) get a manifest. manifest_hash = SHA-256 of
-- artifact_id|version|project_id|hash|size|storage_ref (same formula as server/artifactFormat.ts).
INSERT INTO artifact_manifests(artifact_id, version, project_id, hash, size, storage_ref, mime, kind, manifest, manifest_hash, created_at)
SELECT a.artifact_id, a.version, a.project_id, a.hash, a.size, 'pg:' || a.id, a.mime, 'text',
       jsonb_build_object('schema', 1, 'artifact_id', a.artifact_id, 'version', a.version, 'project_id', a.project_id,
         'filename', a.filename, 'mime', a.mime, 'declared_mime', a.mime, 'kind', 'text', 'size', a.size, 'hash', a.hash,
         'storage_ref', 'pg:' || a.id, 'created_by', a.created_by, 'derived_from', a.derived_from),
       encode(sha256(convert_to(a.artifact_id || '|' || a.version || '|' || a.project_id || '|' || a.hash || '|' || a.size || '|pg:' || a.id, 'UTF8')), 'hex'),
       a.created_at
FROM artifacts a
ON CONFLICT (artifact_id, version) DO NOTHING;
COMMIT;
```

## `009_gate_evidence.sql`

SHA-256: `78b7f65af645032a6fab14e600f0ed7807dd28f175dfb8c3d05ee0b0704f3065`

```sql
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
```

## `010_code_tasks.sql`

SHA-256: `da34ce2b6669d79ac197743dd27856b10c3abe26a27b032edbb6662e9ce46bdd`

```sql
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
```

## `011_code_task_package_approval.sql`

SHA-256: `12668f0ce08a963f97c4c303d6842a38c7b36e24fa72d440afcf55564b423bae`

```sql
-- P20 / BX-22.a: human approval of Task Package before handoff / commit; optional branch SHA after package commit.
ALTER TABLE code_tasks ADD COLUMN IF NOT EXISTS package_approved_at TIMESTAMPTZ;
ALTER TABLE code_tasks ADD COLUMN IF NOT EXISTS package_approved_by TEXT;
ALTER TABLE code_tasks ADD COLUMN IF NOT EXISTS package_branch_sha TEXT;
```

## `012_code_task_decision.sql`

SHA-256: `726d1576005b3190709a2039cf6ac3197434f983cca8e6f56517f80dd3c0ff59`

```sql
BEGIN;
-- P21 / BX-22.b: human decision and structured reviewer findings on a delivered code task (TZ 11.5 steps 7–9).
ALTER TABLE code_tasks
  ADD COLUMN IF NOT EXISTS decision text CHECK (decision IS NULL OR decision IN ('accept', 'repair', 'reject')),
  ADD COLUMN IF NOT EXISTS decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) <= 1000),
  ADD COLUMN IF NOT EXISTS decision_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_findings jsonb;
COMMIT;
```

## `013_repair_loop.sql`

SHA-256: `20211bcfc55f8bb0529ac26330d686ea8f21eae959902e772b251bf71caff50d`

```sql
BEGIN;
-- P22 / BX-23: Repair Loop metadata on code_tasks (TZ 11.6).
ALTER TABLE code_tasks
  ADD COLUMN IF NOT EXISTS repair_of text,
  ADD COLUMN IF NOT EXISTS diff_hash text CHECK (diff_hash IS NULL OR diff_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS error_signature text CHECK (error_signature IS NULL OR error_signature ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS failing_tests integer CHECK (failing_tests IS NULL OR failing_tests >= 0),
  ADD COLUMN IF NOT EXISTS failure_kind text CHECK (failure_kind IS NULL OR failure_kind IN ('build','lint','test','security','criteria','other')),
  ADD COLUMN IF NOT EXISTS ci_restarts integer NOT NULL DEFAULT 0 CHECK (ci_restarts >= 0 AND ci_restarts <= 1),
  ADD COLUMN IF NOT EXISTS repair_stop_reasons jsonb,
  ADD COLUMN IF NOT EXISTS diagnostic_artifact_id text;
COMMIT;
```

## `014_provider_snapshots.sql`

SHA-256: `d420fe270c49caa76943958f01bd6383287745563914090d8bceee2f83882b33`

```sql
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
```
