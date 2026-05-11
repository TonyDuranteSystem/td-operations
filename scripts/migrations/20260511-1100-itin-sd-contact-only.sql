-- 20260511-1100-itin-sd-contact-only.sql
-- Phase 1 ITIN architecture (2026-05-11).
--
-- Rule (from Antonio): ITIN SDs always live on contact_id with
-- account_id = NULL — even when the contact owns an LLC. The ITIN belongs
-- to the person, not the company.
--
-- Scope:
--   - Targets: active ITIN service_deliveries that already have contact_id set.
--     These are the rows where we know which contact owns the ITIN; nulling
--     account_id realigns them with the rule and unblocks the contact-only
--     portal/CRM flows shipped in this PR.
--   - Untouched: completed ITIN rows with no contact_id (sealed history —
--     ~36 rows in sandbox dating to the 2026-04-09 backfill). They reference
--     accounts only because no contact link was available at backfill time;
--     re-deriving contact_id from account_contacts and rewriting them is
--     out of scope for Phase 1 (reporting-only data).
--   - Flagged but untouched: active ITIN rows with NULL contact_id. These
--     are broken (an active service should always know its contact) and
--     need manual triage before the contact-only rule can be applied to
--     them safely. The flag query at the top of this migration surfaces
--     them so they can be remediated.
--
-- DML only (no DDL). Safe to re-run — UPDATE is idempotent.

-- ─── Step 1 — Surface broken rows for manual review ───
-- These rows are active ITIN SDs with no contact link. The migration does
-- NOT touch them; someone (Antonio / Luca) must add a contact_id via
-- account_contacts before they can become contact-only.
SELECT
  id,
  service_name,
  account_id,
  stage,
  start_date,
  '⚠️ active ITIN SD with no contact_id — manual triage required' AS flag
FROM public.service_deliveries
WHERE service_type = 'ITIN'
  AND status = 'active'
  AND contact_id IS NULL;

-- ─── Step 2 — Realign ITIN SDs that already have contact_id ───
-- account_id → NULL, contact_id preserved. Status/stage left as-is.
UPDATE public.service_deliveries
SET
  account_id = NULL,
  updated_at = now()
WHERE service_type = 'ITIN'
  AND contact_id IS NOT NULL
  AND account_id IS NOT NULL
RETURNING id, service_name, contact_id, stage, status;
