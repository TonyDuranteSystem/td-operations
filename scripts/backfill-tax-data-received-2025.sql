-- ============================================================================
-- Backfill: reconcile tax_returns.data_received to the audited SD stage
-- Scope: MMLLC + SMLLC, tax_year 2025 season (Phase 1 — "Card = Truth")
-- ============================================================================
--
-- WHY: data_received was set true WITHOUT a date (by the dashboard toggle /
-- a bulk migration). A dateless "received" flag is the bug — it BLOCKS the
-- client from submitting their wizard (app/api/portal/wizard-submit/route.ts
-- requires data_received=false) and hides their portal banner
-- (app/portal/page.tsx). Phase 1 plugged the leak (the toggle now stamps a
-- date); this backfill clears the EXISTING stale flags.
--
-- RULE: reconcile the flag to the audited Tax Return SD stage (the CRM truth).
--   CLEAR   = flag true + NO date + SD stage pre-data  -> set data_received=false
--   REVIEW  = flag true + HAS date + SD stage pre-data  -> ambiguous, NO auto-change
--   SET     = flag false + SD stage data-received       -> none found this run
--   (CONSISTENT rows are left untouched.)
--
-- "Data-received SD stages" = Data Received / Preparation / TR Completed / TR Filed.
--
-- SAFETY: run Section A (dry-run, read-only) first. Section B (apply) writes to
-- the PROTECTED tax_returns table — run ONLY via execute_sql(mode:"write",
-- reason:"...") AFTER Antonio approves the dry-run output. Section C lists the
-- REVIEW rows for manual, per-client handling (never auto-changed).
--
-- Dry-run produced 2026-06-08: 21 CLEAR (18 MMLLC + 3 SMLLC), 11 REVIEW (SMLLC),
-- 0 SET, 177 CONSISTENT.
-- ============================================================================


-- ─── Section A — DRY-RUN (read-only): every row that would change ───────────
WITH tr AS (
  SELECT t.id, t.company_name, t.return_type, t.tax_year, t.status,
         t.data_received, t.data_received_date,
         sd.stage AS sd_stage
  FROM tax_returns t
  LEFT JOIN service_deliveries sd
    ON sd.account_id = t.account_id
   AND sd.service_type = 'Tax Return'
   AND sd.status <> 'cancelled'
  WHERE t.return_type IN ('MMLLC','SMLLC')
)
SELECT
  CASE WHEN data_received_date IS NULL
       THEN 'CLEAR (data_received true->false)'
       ELSE 'REVIEW (dated; NO auto-change)' END AS proposed,
  return_type, company_name, tax_year, status AS tr_status, data_received_date, sd_stage
FROM tr
WHERE data_received = true
  AND (sd_stage IS NULL OR sd_stage NOT IN ('Data Received','Preparation','TR Completed','TR Filed'))
ORDER BY proposed, return_type, company_name;


-- ─── Section B — APPLY (writes!) — run ONLY after approval ───────────────────
-- execute_sql(mode:"write", reason:"backfill: clear stale dateless data_received
--   on pre-data MMLLC/SMLLC tax returns (Phase 1 Card=Truth)")
-- Self-selects ONLY the CLEAR rows (flag true + date NULL + SD pre-data). The
-- REVIEW rows (date present) are excluded by the `data_received_date IS NULL`
-- predicate and are never touched here.
--
-- WITH clr AS (
--   SELECT t.id
--   FROM tax_returns t
--   LEFT JOIN service_deliveries sd
--     ON sd.account_id = t.account_id
--    AND sd.service_type = 'Tax Return'
--    AND sd.status <> 'cancelled'
--   WHERE t.return_type IN ('MMLLC','SMLLC')
--     AND t.data_received = true
--     AND t.data_received_date IS NULL
--     AND (sd.stage IS NULL OR sd.stage NOT IN ('Data Received','Preparation','TR Completed','TR Filed'))
-- ),
-- updated AS (
--   UPDATE tax_returns t
--   SET data_received = false, updated_at = now()
--   FROM clr WHERE t.id = clr.id
--   RETURNING t.id, t.company_name
-- )
-- SELECT count(*) AS cleared, array_agg(company_name ORDER BY company_name) FROM updated;


-- ─── Section C — REVIEW list (manual, per-client decision) ──────────────────
-- These have a real-looking data_received_date but a pre-data SD stage:
--   * the 2026-04-15 cohort (Bontempo, KML advertising, MG Media Tech) =
--     suspected bulk-set;
--   * AP Millionaire / Levante have tax status 'Data Received' but SD
--     '1st Installment Paid' (status vs SD mismatch);
--   * Mojo Labs is 'TR Filed' with no SD (actually fine — leave it).
-- Decide each by hand (check wizard_progress + Drive docs + bank feed).
WITH tr AS (
  SELECT t.company_name, t.tax_year, t.status, t.data_received_date,
         sd.stage AS sd_stage
  FROM tax_returns t
  LEFT JOIN service_deliveries sd
    ON sd.account_id = t.account_id
   AND sd.service_type = 'Tax Return'
   AND sd.status <> 'cancelled'
  WHERE t.return_type IN ('MMLLC','SMLLC')
)
SELECT company_name, tax_year, status AS tr_status, data_received_date, sd_stage
FROM tr
WHERE data_received_date IS NOT NULL
  AND (sd_stage IS NULL OR sd_stage NOT IN ('Data Received','Preparation','TR Completed','TR Filed'))
  AND EXISTS (
    SELECT 1 FROM tax_returns t2 WHERE t2.company_name = tr.company_name AND t2.data_received = true
  )
ORDER BY company_name;
