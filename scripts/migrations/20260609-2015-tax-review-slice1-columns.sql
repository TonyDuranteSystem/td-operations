-- 20260609-2015-tax-review-slice1-columns.sql
-- Slice 1 (Tax Submission Review workflow) — Parts 1 & 2 ONLY: additive columns.
-- Part 3 (new pipeline_stages rows + ×10 gap-renumber + service_deliveries.stage_order
-- re-sync) is a SEPARATE migration, pending the spec.
--
-- All columns here are purely additive and safe in a single transaction (no enums,
-- no data backfill beyond column DEFAULTs). Existing rows are preserved:
--   • review_status defaults NULL  → existing submissions untouched.
--   • review_history defaults '[]' → existing submissions get an empty array.
--   • pipeline_stages.client_visible / board_visible default true → existing stages
--     remain visible (current behaviour).
--
-- review_status is TEXT (not an enum), per decision 2026-06-09 — mirrors the existing
-- tax_return_submissions.status text column and avoids the ALTER TYPE ADD VALUE
-- transaction trap. Allowed values (enforced in app code, not the DB):
--   submitted, under_review, revision_requested, resubmitted, approved, confirmed, reopened


-- ─── Part 1 — tax_return_submissions: review tracking ───────────────────────────
ALTER TABLE tax_return_submissions ADD COLUMN IF NOT EXISTS review_status TEXT;
ALTER TABLE tax_return_submissions ADD COLUMN IF NOT EXISTS review_history JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ─── Part 2 — pipeline_stages: client/board display metadata ────────────────────
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS client_label   TEXT;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS icon           TEXT;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS color          TEXT;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS client_visible BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS board_visible  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS stale_days     INTEGER;
