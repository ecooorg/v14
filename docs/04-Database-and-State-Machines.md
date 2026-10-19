# 4. Database and State Machines

## 4.1 Database policy

PostgreSQL is the durable store for Project Mode. The repository contains 14 ordered migrations under `migrations/`; `scripts/migrate.mjs` and `schema_migrations` track applied versions. The application start script runs migrations when `DATABASE_URL` is present. Production migrations must be run only with owner authorization and a verified backup/rollback plan.

The following schema inventory is derived from `CREATE TABLE` statements in the archive. It is not a substitute for applying and testing the migrations against PostgreSQL. Constraints, indexes, foreign keys and triggers must be read from the original SQL files; those files remain the executable schema authority.

## 4.2 Table inventory

### `projects` (introduced by `001_project_state.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `name` | `text NOT NULL CHECK (length(name) BETWEEN 1 AND 200)` |
| `status` | `text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed','archived'))` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

### `project_states` (introduced by `001_project_state.sql`)

| Column | Definition |
|---|---|
| `project_id` | `text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE` |
| `state_version` | `integer NOT NULL DEFAULT 1 CHECK (state_version >= 1)` |
| `state` | `jsonb NOT NULL DEFAULT '{}'::jsonb` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

### `project_state_versions` (introduced by `001_project_state.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `state_version` | `integer NOT NULL CHECK (state_version >= 1)` |
| `state` | `jsonb NOT NULL` |
| `actor` | `text NOT NULL CHECK (actor IN ('human','agent','tool','system'))` |
| `source_ref` | `text` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

### `project_events` (introduced by `001_project_state.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `event_type` | `text NOT NULL` |
| `payload` | `jsonb NOT NULL DEFAULT '{}'::jsonb` |
| `actor` | `text NOT NULL CHECK (actor IN ('human','agent','tool','system'))` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

### `audit_events` (introduced by `001_project_state.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `project_id` | `text REFERENCES projects(id) ON DELETE SET NULL` |
| `event_type` | `text NOT NULL` |
| `actor` | `text NOT NULL` |
| `details` | `jsonb NOT NULL DEFAULT '{}'::jsonb` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

### `rate_limits` (introduced by `001_project_state.sql`)

| Column | Definition |
|---|---|
| `bucket_key` | `text PRIMARY KEY` |
| `window_started_at` | `timestamptz NOT NULL` |
| `request_count` | `integer NOT NULL DEFAULT 0 CHECK (request_count >= 0)` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

### `schema_migrations` (introduced by `001_project_state.sql`)

| Column | Definition |
|---|---|
| `version` | `text PRIMARY KEY` |
| `applied_at` | `timestamptz NOT NULL DEFAULT now()` |

### `artifacts` (introduced by `002_artifacts_ledger.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `artifact_id` | `text NOT NULL` |
| `version` | `integer NOT NULL CHECK (version >= 1)` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `filename` | `text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255)` |
| `mime` | `text NOT NULL` |
| `size` | `integer NOT NULL CHECK (size >= 0 AND size <= 5242880)` |
| `hash` | `text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$')` |
| `content` | `bytea NOT NULL` |
| `created_by` | `text NOT NULL` |
| `derived_from` | `jsonb NOT NULL DEFAULT '[]'::jsonb` |
| `security_status` | `text NOT NULL DEFAULT 'unchecked'` |
| `classification` | `text NOT NULL DEFAULT 'unclassified'` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

### `usage_ledger` (introduced by `002_artifacts_ledger.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `run_id` | `text` |
| `provider_id` | `text NOT NULL` |
| `model_id` | `text NOT NULL` |
| `input_tokens` | `integer NOT NULL DEFAULT 0` |
| `cached_tokens` | `integer NOT NULL DEFAULT 0` |
| `output_tokens` | `integer NOT NULL DEFAULT 0` |
| `latency_ms` | `integer NOT NULL DEFAULT 0` |
| `retries` | `integer NOT NULL DEFAULT 0` |
| `status` | `text NOT NULL` |
| `error_class` | `text` |
| `cost_estimate` | `numeric` |
| `route_decision_id` | `text` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

### `connection_checks` (introduced by `002_artifacts_ledger.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `connector` | `text NOT NULL` |
| `status` | `text NOT NULL` |
| `reason` | `text` |
| `http_status` | `integer` |
| `latency_ms` | `integer` |

### `route_decisions` (introduced by `003_route_decisions.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `run_id` | `text` |
| `policy_version` | `text NOT NULL` |
| `sensitivity` | `text NOT NULL DEFAULT 'normal'` |
| `status` | `text NOT NULL` |
| `reason` | `text` |
| `candidates` | `jsonb NOT NULL DEFAULT '[]'::jsonb` |
| `rejected` | `jsonb NOT NULL DEFAULT '[]'::jsonb` |
| `attempts` | `jsonb NOT NULL DEFAULT '[]'::jsonb` |
| `units_spent` | `integer NOT NULL DEFAULT 0` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

### `model_health` (introduced by `004_model_health.sql`)

| Column | Definition |
|---|---|
| `key` | `text PRIMARY KEY` |
| `kind` | `text NOT NULL CHECK (kind IN ('model','provider'))` |
| `successes` | `integer NOT NULL DEFAULT 0` |
| `failures` | `integer NOT NULL DEFAULT 0` |
| `avg_latency_ms` | `double precision` |
| `last_error_class` | `text` |
| `cooldown_until` | `bigint` |
| `disabled_at` | `bigint` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

### `tasks` (introduced by `005_tasks_runs.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `title` | `text NOT NULL CHECK (length(title) BETWEEN 1 AND 200)` |
| `input` | `jsonb NOT NULL` |
| `input_fingerprint` | `text NOT NULL CHECK (length(input_fingerprint) = 64)` |
| `idempotency_key` | `text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200)` |
| `state` | `text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','READY','QUEUED','RUNNING','VALIDATING','PASS','FAIL','BLOCKED','CANCELLED'))` |
| `version` | `integer NOT NULL DEFAULT 1 CHECK (version >= 1)` |
| `max_attempts` | `integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10)` |
| `blocked_reason` | `text` |
| `validated_fingerprint` | `text` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

### `runs` (introduced by `005_tasks_runs.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `task_id` | `text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `attempt` | `integer NOT NULL CHECK (attempt >= 1)` |
| `status` | `text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','ABANDONED'))` |
| `idempotency_key` | `text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200)` |
| `input_fingerprint` | `text NOT NULL` |
| `input_refs` | `jsonb NOT NULL DEFAULT '[]'::jsonb` |
| `profile` | `text` |
| `profile_version` | `text` |
| `provider_id` | `text` |
| `model_id` | `text` |
| `policy_version` | `text` |
| `budget` | `jsonb` |
| `evidence` | `jsonb NOT NULL DEFAULT '[]'::jsonb` |
| `queued_at` | `timestamptz NOT NULL DEFAULT now()` |
| `started_at` | `timestamptz` |
| `finished_at` | `timestamptz` |

### `task_events` (introduced by `005_tasks_runs.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `seq` | `bigserial NOT NULL` |
| `task_id` | `text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `run_id` | `text` |
| `event_type` | `text NOT NULL` |
| `from_state` | `text` |
| `to_state` | `text` |
| `actor` | `text NOT NULL` |
| `details` | `jsonb NOT NULL DEFAULT '{}'::jsonb` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

### `jobs` (introduced by `006_jobs.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `seq` | `bigserial NOT NULL` |
| `run_id` | `text NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE` |
| `task_id` | `text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `status` | `text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','LEASED','DONE','ABANDONED','CANCELLED'))` |
| `available_at` | `timestamptz NOT NULL DEFAULT now()` |
| `claims` | `integer NOT NULL DEFAULT 0 CHECK (claims >= 0)` |
| `lease_owner` | `text` |
| `lease_until` | `timestamptz` |
| `heartbeat_at` | `timestamptz` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `finished_at` | `timestamptz` |

### `budgets` (introduced by `007_budgets_plans_approvals.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `scope` | `text NOT NULL CHECK (scope IN ('project','task','run'))` |
| `scope_id` | `text NOT NULL` |
| `limits` | `jsonb NOT NULL DEFAULT '{}'::jsonb` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

### `project_settings` (introduced by `007_budgets_plans_approvals.sql`)

| Column | Definition |
|---|---|
| `project_id` | `text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE` |
| `approval_mode` | `text NOT NULL DEFAULT 'supervised' CHECK (approval_mode IN ('supervised','manual'))` |
| `max_concurrent_runs` | `integer NOT NULL DEFAULT 2 CHECK (max_concurrent_runs BETWEEN 1 AND 10)` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

### `plans` (introduced by `007_budgets_plans_approvals.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `version` | `integer NOT NULL CHECK (version >= 1)` |
| `status` | `text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED'))` |
| `source` | `text NOT NULL CHECK (source IN ('template','model','human'))` |
| `template` | `text` |
| `nodes` | `jsonb NOT NULL` |
| `total_units` | `integer NOT NULL DEFAULT 0 CHECK (total_units >= 0)` |
| `created_by` | `text NOT NULL` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `decided_at` | `timestamptz` |

### `plan_tasks` (introduced by `007_budgets_plans_approvals.sql`)

| Column | Definition |
|---|---|
| `plan_id` | `text NOT NULL REFERENCES plans(id) ON DELETE CASCADE` |
| `node_key` | `text NOT NULL` |
| `task_id` | `text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE` |

### `approvals` (introduced by `007_budgets_plans_approvals.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `seq` | `bigserial NOT NULL` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `kind` | `text NOT NULL CHECK (kind IN ('plan','budget','merge_ready','state_decision','destructive','task_start'))` |
| `subject_id` | `text NOT NULL` |
| `status` | `text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED'))` |
| `details` | `jsonb NOT NULL DEFAULT '{}'::jsonb` |
| `requested_by` | `text NOT NULL` |
| `decided_by` | `text` |
| `decision_reason` | `text` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `decided_at` | `timestamptz` |

### `artifact_manifests` (introduced by `008_artifact_manifests.sql`)

| Column | Definition |
|---|---|
| `artifact_id` | `text NOT NULL` |
| `version` | `integer NOT NULL CHECK (version >= 1)` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `hash` | `text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$')` |
| `size` | `integer NOT NULL CHECK (size >= 0 AND size <= 5242880)` |
| `storage_ref` | `text NOT NULL` |
| `mime` | `text NOT NULL` |
| `kind` | `text NOT NULL CHECK (kind IN ('text', 'binary', 'archive', 'executable'))` |
| `manifest` | `jsonb NOT NULL` |
| `manifest_hash` | `text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$')` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

### `gate_evidence` (introduced by `009_gate_evidence.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `task_id` | `text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE` |
| `gate` | `text NOT NULL CHECK (gate IN ('requirements','spec','build','test','test_integrity','security','review','release_candidate'))` |
| `status` | `text NOT NULL CHECK (status IN ('PASS','FAIL','BLOCKED','NOT_RUN','REAL_ONLY'))` |
| `rules_version` | `text NOT NULL` |
| `source` | `text NOT NULL CHECK (source IN ('ci','diff','approval','system'))` |
| `source_ref` | `text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 300)` |
| `tool` | `text NOT NULL` |
| `tool_version` | `text` |
| `exit_code` | `integer` |
| `commit_sha` | `text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$')` |
| `details` | `jsonb NOT NULL DEFAULT '{}'::jsonb` |
| `log_url` | `text CHECK (log_url IS NULL OR log_url ~ '^https://')` |
| `artifact_refs` | `jsonb NOT NULL DEFAULT '[]'::jsonb` |
| `invalidated_at` | `timestamptz` |
| `invalidated_reason` | `text` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

### `gate_waivers` (introduced by `009_gate_evidence.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `task_id` | `text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE` |
| `gate` | `text NOT NULL CHECK (gate IN ('requirements','spec','build','test','test_integrity','security','review','release_candidate'))` |
| `commit_sha` | `text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$')` |
| `reason` | `text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000)` |
| `actor` | `text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 100)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

### `task_heads` (introduced by `009_gate_evidence.sql`)

| Column | Definition |
|---|---|
| `task_id` | `text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `commit_sha` | `text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$')` |
| `pr_number` | `integer` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

### `code_tasks` (introduced by `010_code_tasks.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE CASCADE` |
| `task_id` | `text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE` |
| `run_id` | `text` |
| `attempt` | `integer NOT NULL CHECK (attempt >= 1)` |
| `executor` | `text NOT NULL CHECK (executor IN ('manual','model_patch'))` |
| `status` | `text NOT NULL CHECK (status IN ('WAITING_HUMAN','RUNNING','DELIVERED','FAILED','BLOCKED'))` |
| `delivery` | `text CHECK (delivery IS NULL OR delivery IN ('pr','branch','diff'))` |
| `base_branch` | `text NOT NULL CHECK (base_branch ~ '^[A-Za-z0-9._/-]{1,100}$')` |
| `branch` | `text CHECK (branch IS NULL OR branch ~ '^biforge/[A-Za-z0-9_-]{1,128}$')` |
| `head_sha` | `text CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$')` |
| `pr_number` | `integer CHECK (pr_number IS NULL OR pr_number >= 1)` |
| `pr_url` | `text CHECK (pr_url IS NULL OR pr_url ~ '^https://')` |
| `executor_note` | `text CHECK (executor_note IS NULL OR length(executor_note) <= 500)` |
| `files_changed` | `integer CHECK (files_changed IS NULL OR files_changed >= 0)` |
| `lines_changed` | `integer CHECK (lines_changed IS NULL OR lines_changed >= 0)` |
| `status_reason` | `text CHECK (status_reason IS NULL OR length(status_reason) <= 500)` |
| `violations` | `jsonb NOT NULL DEFAULT '[]'::jsonb` |
| `package_hash` | `text NOT NULL CHECK (package_hash ~ '^[0-9a-f]{64}$')` |
| `package` | `jsonb NOT NULL` |
| `package_artifact_id` | `text` |
| `package_artifact_version` | `integer` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

### `provider_snapshots` (introduced by `014_provider_snapshots.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `provider_id` | `text NOT NULL` |
| `status` | `text NOT NULL CHECK (status IN ('OK', 'DRIFT', 'FAIL', 'NOT_RUN', 'BLOCKED'))` |
| `model_ids` | `jsonb NOT NULL DEFAULT '[]'::jsonb` |
| `rate_limit_headers` | `jsonb NOT NULL DEFAULT '{}'::jsonb` |
| `details` | `jsonb NOT NULL DEFAULT '{}'::jsonb` |

### `monitor_alerts` (introduced by `014_provider_snapshots.sql`)

| Column | Definition |
|---|---|
| `id` | `text PRIMARY KEY` |
| `alert_key` | `text NOT NULL` |
| `level` | `text NOT NULL CHECK (level IN ('info', 'warn', 'critical'))` |
| `provider_id` | `text` |
| `message` | `text NOT NULL` |
| `details` | `jsonb NOT NULL DEFAULT '{}'::jsonb` |
| `opened_at` | `timestamptz NOT NULL DEFAULT now()` |
| `closed_at` | `timestamptz` |

## 4.3 Project State schema

### Project envelope

`Project` fields: `id` (stable URL/DB-safe ID, 1–128 chars, letters/digits/underscore/hyphen), `name` (trimmed 1–200 chars), `status` (`draft|active|paused|completed|archived`), optional ISO datetime `createdAt` and `updatedAt`. State is a JSON object; the State schema deliberately allows domain-specific root keys. If `state.passport` exists, it must pass `passportSchema`. If `state.items` exists, it must pass `stateItemsSchema`.

### Passport

Fields: `status: proposed|confirmed`; `projectType` (1–80 chars); `goal`, `users`, `inputsOutputs`, `constraints`, `securityData`, `successCriteria` (each trimmed, max 2000 chars); strict `budget` object with `calls` (0–1,000,000), `tokens` (0–1,000,000,000), `executorRuns` (0–100,000); `executor: manual|model_patch`; `humanLevel: supervised|manual`. Default passport has status `proposed`, projectType `unspecified`, budget `{calls:100,tokens:500000,executorRuns:0}`, executor `manual`, humanLevel `supervised`.

### State items and provenance

Six sections are present: `facts`, `unknowns`, `hypotheses`, `decisions`, `risks`, `requirements`. IDs are generated by the server using prefixes `F`, `U`, `H`, `D`, `R`, `RQ`. Each item has system-owned metadata (ID, author, timestamp, source reference and, where applicable, review status). Models cannot set system fields or make decisions.

- Facts: a fact without `ref` is marked unverified. Established context facts must be confirmed, have a reference, and not be marked unverified.
- Unknowns: impact `high|medium|low`, status `open|resolved`, review `proposed|confirmed|rejected`.
- Hypotheses: origin `model|human|simple_import`, status/review `proposed|confirmed|rejected`.
- Decisions: `decided_by` is literal `human`; includes rationale. Models cannot create/change/reject decisions.
- Risks: severity `high|medium|low`, status `open|mitigated`, review `proposed|confirmed|rejected`.
- Requirements: non-empty acceptance criteria, status/review `proposed|confirmed|rejected`.

State patch operations are `add`, `update`, `reject`; a patch has 1–100 operations. Patches are atomic: if any operation fails schema/policy checks, none of the operations are applied. Models can update only proposed items. State compaction uses deterministic priority and must not compact decisions, requirements, or high-severity open risks.

## 4.4 Task / Run machine

### Task states

`DRAFT → READY → QUEUED → RUNNING → VALIDATING → PASS` is the success path, but every transition is guarded. `DRAFT` may move to `READY` or `CANCELLED`; `READY` to `QUEUED`, `BLOCKED`, or `CANCELLED`; `QUEUED` to `RUNNING`, `BLOCKED`, `CANCELLED`, or `FAIL`; `RUNNING` to `VALIDATING`, `FAIL`, `BLOCKED`, or `CANCELLED`; `VALIDATING` to `PASS`, `FAIL`, `BLOCKED`, or `CANCELLED`; `PASS` may reopen only to `VALIDATING` when input changed; `FAIL` may return to `READY` only while attempts remain; `BLOCKED` may return to `READY`, become `FAIL`, or `CANCELLED`; `CANCELLED` is terminal. Moves involving `QUEUED`/`RUNNING` require Run API context.

`PASS` requires validation `{passed:true, evidence:[one or more non-empty strings]}`. A Run `SUCCEEDED` maps to Task `VALIDATING`, not `PASS`. `FAILED`/`TIMED_OUT` maps to `FAIL`, unless blocked by budget, which maps to `BLOCKED`; `CANCELLED` maps to `CANCELLED`; `ABANDONED` maps to `BLOCKED` with recovery reason. Default max attempts is 3 (database permits 1–10).

### Run states

`QUEUED → RUNNING → SUCCEEDED|FAILED|TIMED_OUT|CANCELLED|ABANDONED`. Terminal Run states have no outgoing transitions.

### Job queue and lease

Job states: `QUEUED`, `LEASED`, `DONE`, `ABANDONED`, `CANCELLED`. Defaults: lease 60,000 ms; heartbeat 20,000 ms; poll 2,000 ms. `heartbeatMs * 2 <= leaseMs` is required. Lease is expired when `now >= lease_until`. Worker recovers expired work, claims a job, heartbeats the lease, aborts on lease loss, and completes the job only if ownership is still valid. The worker library is not started by `server.ts` in this snapshot; runtime activation must be verified separately.

## 4.5 Plans, approvals and budgets

- Maximum plan tasks: 12. A plan node has key, title, task, nullable profile, dependency keys, units, optional artifact output, and acceptance criteria. Keys must match `[a-z0-9_-]{1,40}`.
- Plan sources: `template|model|human`; statuses in DB: `PENDING|APPROVED|REJECTED|SUPERSEDED`. Human approval is required.
- Approval kinds: `plan`, `budget`, `merge_ready`, `state_decision`, `destructive`, `task_start`; statuses `PENDING|APPROVED|REJECTED`. No autonomous approval mode exists. Modes are `supervised|manual`.
- Budget scopes: `project|task|run`. Limit keys: max model calls, tokens, cost units, wall-clock ms, attempts, code tasks. Null/missing means unlimited. A request is over budget when `used + requested > max`. Increasing a previously bounded limit or removing it counts as raising budget and is human-only.

## 4.6 Code executor machine

Executor IDs: `manual`, `model_patch`. States: `WAITING_HUMAN`, `RUNNING`, `DELIVERED`, `FAILED`, `BLOCKED`. At most one active (`WAITING_HUMAN` or `RUNNING`) code task per Task is enforced by a partial unique index. `DELIVERED` rows require branch, head SHA, files changed and lines changed. `BLOCKED`/`FAILED` require a reason. Generated patches must pass path allowlists, protected-path checks, secret scanning, file/line/byte limits and generated-source validation.

Limits in `server/codeExecutor.ts`: default max files 10; default max changed lines 400; max diff 512,000 bytes; max file 1,000,000 bytes; max `PACKAGE.md` 1,000,000 bytes. Exact transitions are encoded in `TRANSITIONS` in that file and should be used by any reimplementation rather than inferred from UI labels.

## 4.7 Gates and evidence

Gate names: `requirements`, `spec`, `build`, `test`, `test_integrity`, `security`, `review`, `release_candidate`. Evidence statuses: `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`, `REAL_ONLY`; `WAIVED` is represented by a separate human waiver record, not a normal evidence record. Evidence binds to a 40-hex commit SHA and a rules version, tool, check name, allowed source and source reference. Evidence for another commit or invalidated evidence is ignored. Latest valid evidence per check wins. `FAIL` outranks `BLOCKED`, `NOT_RUN` and `REAL_ONLY`; `PASS` requires evidence. Release Candidate passes only when every required gate is PASS or WAIVED for the same commit.

## 4.8 Migration and compatibility invariants

- Never edit an already-applied migration for a live environment; add a forward migration.
- Preserve `schema_migrations` and verify the full expected sequence after migration.
- Prefer expand/contract changes so code version N can run against schema N−1 where the rollout strategy requires it.
- Test migrations on a clean PostgreSQL 16 service and run live database contract tests. CI defines a PostgreSQL 16 service in `.github/workflows/ci.yml`.
