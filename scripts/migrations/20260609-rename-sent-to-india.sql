-- 20260609-rename-sent-to-india.sql  —  PART 1 of 2
-- Slice 0 — Rename "Sent to India" -> "Sent to Accountant" (PHASE 1: additive only).
--
-- ⚠️ THIS IS PART 1. It does everything EXCEPT migrate the status enum value.
--    The status migration lives in PART 2:
--        20260609-rename-sent-to-india-part2-status.sql
--    PART 2 MUST be run as a SEPARATE statement/transaction AFTER this file has
--    COMMITTED — Postgres forbids using a newly ALTER TYPE ... ADD VALUE label in the
--    same transaction that adds it ("unsafe use of new value ... must be committed
--    before they can be used", SQLSTATE 55P04). Splitting the files makes that
--    impossible to get wrong: run this file, then run part 2.
--
-- Part 1 is safe to run as a single transaction: it ADDs the new 'Sent to Accountant'
-- enum label but does NOT use it here (the data copy below only touches the new
-- columns + the separate accountant_status enum, never tax_returns.status).
--
-- Adds the new columns / enum / status label ALONGSIDE the old ones and copies the data.
-- The OLD columns (sent_to_india, sent_to_india_date, india_status, india_follow_up_count)
-- and the OLD 'Sent to India' enum label are NOT dropped here. A later migration drops them
-- once all code is cut over to the new names and verified in production.
--
-- Verified against sandbox (xjcxlmlpeywtwkhstjlw) on 2026-06-09:
--   • india_status is itself an ENUM type with labels: Not Sent / Sent - Pending /
--     In Progress / Completed / Filed  — IDENTICAL to the accountant_status enum below,
--     so india_status::text::accountant_status casts cleanly for every existing value.
--   • tax_return_status currently contains the label 'Sent to India'.


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — new boolean / date / count columns (additive, safe)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE tax_returns ADD COLUMN IF NOT EXISTS sent_to_accountant BOOLEAN DEFAULT FALSE;
ALTER TABLE tax_returns ADD COLUMN IF NOT EXISTS sent_to_accountant_date DATE;
ALTER TABLE tax_returns ADD COLUMN IF NOT EXISTS accountant_follow_up_count INTEGER DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — new accountant_status enum (mirrors india_status labels exactly) + column
-- (CREATE TYPE has no IF NOT EXISTS; the DO block makes it idempotent.)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE accountant_status AS ENUM ('Not Sent', 'Sent - Pending', 'In Progress', 'Completed', 'Filed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE tax_returns ADD COLUMN IF NOT EXISTS accountant_status accountant_status DEFAULT 'Not Sent';

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3 — add the new status label to tax_return_status.
-- Safe here because nothing in PART 1 USES the new label. It is consumed only by
-- PART 2 (a separate transaction).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE tax_return_status ADD VALUE IF NOT EXISTS 'Sent to Accountant';

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4 — copy data old -> new columns. Does NOT touch tax_returns.status.
-- NULL india_status casts to NULL (column is nullable) — fine.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE tax_returns SET
  sent_to_accountant         = sent_to_india,
  sent_to_accountant_date    = sent_to_india_date,
  accountant_status          = india_status::text::accountant_status,
  accountant_follow_up_count = india_follow_up_count;

-- ▶ NEXT: run 20260609-rename-sent-to-india-part2-status.sql (separate transaction).
