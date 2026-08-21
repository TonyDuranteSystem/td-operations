-- Workspace-scoped coverage answers (2026-08-20, tax-workspace hard-stop plan).
--
-- Mirrors the shape already proven on real client accounts
-- (tax_return_submissions.financials_meta.coverage_answers, a
-- { [questionKey]: { answer, at } } map — lib/tax/coverage.ts CoverageAnswers)
-- so lib/tax/coverage.ts's pure functions work identically against either
-- source. Workspaces have no financials_meta/submissions row of their own;
-- this is the workspace equivalent, following the same jsonb-column-on-the-
-- row precedent already established by prior_return_snapshot on this same
-- table (20260701-2340-pnl-workspaces.sql).
--
-- NULL default (not '{}'::jsonb) matches prior_return_snapshot's own
-- nullable default on this table — callers already null-coalesce reads.

ALTER TABLE pnl_workspaces
  ADD COLUMN IF NOT EXISTS coverage_answers jsonb;

COMMENT ON COLUMN pnl_workspaces.coverage_answers IS
  'Workspace-scoped answers to lib/tax/coverage.ts CoverageQuestion prompts — { [questionKey]: { answer: "no_activity"|"had_activity", at: ISO8601 } }. Mirrors tax_return_submissions.financials_meta.coverage_answers for real client accounts.';
