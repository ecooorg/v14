BEGIN;
-- P21 / BX-22.b: human decision and structured reviewer findings on a delivered code task (TZ 11.5 steps 7–9).
ALTER TABLE code_tasks
  ADD COLUMN IF NOT EXISTS decision text CHECK (decision IS NULL OR decision IN ('accept', 'repair', 'reject')),
  ADD COLUMN IF NOT EXISTS decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) <= 1000),
  ADD COLUMN IF NOT EXISTS decision_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_findings jsonb;
COMMIT;
