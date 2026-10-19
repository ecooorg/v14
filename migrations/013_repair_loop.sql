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
