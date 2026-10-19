-- P20 / BX-22.a: human approval of Task Package before handoff / commit; optional branch SHA after package commit.
ALTER TABLE code_tasks ADD COLUMN IF NOT EXISTS package_approved_at TIMESTAMPTZ;
ALTER TABLE code_tasks ADD COLUMN IF NOT EXISTS package_approved_by TEXT;
ALTER TABLE code_tasks ADD COLUMN IF NOT EXISTS package_branch_sha TEXT;
