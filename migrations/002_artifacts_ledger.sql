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
