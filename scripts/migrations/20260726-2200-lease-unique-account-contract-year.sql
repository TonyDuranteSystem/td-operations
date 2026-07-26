-- One office lease per (account, contract year, tenant company).
--
-- Why: createLease guards duplicates with a SELECT-then-INSERT, which is not
-- race-safe — two payment events landing at the same instant (bank-feed matcher
-- + manual mark-paid, or the renewal auto-create firing twice) could each pass
-- the check and insert a second lease row for the same year. This adds the
-- DB-level guarantee; the code-side retry treats the unique violation as a
-- duplicate (see lib/operations/lease.ts).
--
-- KEY INCLUDES tenant_company ON PURPOSE: an account can legitimately hold TWO
-- concurrent leases in the same year with DIFFERENT tenants — a company lease
-- and a separate personal lease for its owner (see the suite-reuse note in
-- lib/operations/lease.ts, and prod account 281873a8 which has exactly this for
-- 2026). Keying on (account_id, contract_year) alone would delete one of them
-- and permanently block re-creating it. Keying on the tenant too keeps both,
-- while still blocking the real race (createLease always writes
-- tenant_company = account.company_name, so two racing company-lease inserts
-- collide on the same 3-column key).
--
-- ⚠️ PRODUCTION PROMOTION: the DELETE below removes true duplicates only —
-- rows sharing (account_id, contract_year, tenant_company). Verified 2026-07-26
-- that production has ZERO such groups, so the DELETE is a no-op there; it stays
-- as an idempotent guard. Still SELECT the groups (query below) before promoting.
--
--   SELECT account_id, contract_year, tenant_company, count(*)
--   FROM lease_agreements
--   WHERE account_id IS NOT NULL AND contract_year IS NOT NULL
--   GROUP BY account_id, contract_year, tenant_company HAVING count(*) > 1;

-- 1. Dedup true duplicates: within each (account_id, contract_year,
--    tenant_company) group keep the most progressed lease
--    (signed > viewed > sent > draft), newest as tiebreak.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY account_id, contract_year, tenant_company
      ORDER BY
        CASE status
          WHEN 'signed' THEN 4
          WHEN 'viewed' THEN 3
          WHEN 'sent'   THEN 2
          WHEN 'draft'  THEN 1
          ELSE 0
        END DESC,
        created_at DESC
    ) AS rn
  FROM lease_agreements
  -- tenant_company IS NOT NULL: the unique index treats NULL tenants as distinct
  -- (never collides), so the dedup must not group/delete NULL-tenant legacy rows
  -- either — it must be no stricter than the constraint it enforces.
  WHERE account_id IS NOT NULL AND contract_year IS NOT NULL AND tenant_company IS NOT NULL
)
DELETE FROM lease_agreements
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2. Enforce one lease per (account, year, tenant) going forward. Partial so
--    rows with a NULL account_id or contract_year (legacy / in-progress) never
--    collide. tenant_company is NOT NULL (createLease always sets it).
CREATE UNIQUE INDEX IF NOT EXISTS uq_lease_account_year_tenant
  ON lease_agreements (account_id, contract_year, tenant_company)
  WHERE account_id IS NOT NULL AND contract_year IS NOT NULL;
