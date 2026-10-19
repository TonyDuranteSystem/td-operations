-- dev job 264bb882 (Stop Drive S1b) -- the accountant hand-off is RETIRED (Antonio, 2026-10-18).
-- Two live catalog rows still tell staff to hand a return to the accountant / India:
--   action_events/financials_confirmed : "...then send to the accountant"
--   action_events/tax_return_signed    : "Send to India to file"
-- Only the wording of next_step changes; nothing else in the rows, no tax_returns data. Idempotent: a row that no longer
-- has the old wording is left alone (rows_updated = 0 in the report). One plain statement (no DO block) so the SQL tool accepts it.
--
-- Read-only check to run FIRST (expect exactly these two next_step values):
--   SELECT slug, metadata->>'next_step' AS next_step FROM catalog_entries
--    WHERE catalog_id = 'action_events' AND slug IN ('financials_confirmed','tax_return_signed');
-- Production read on 2026-10-18: tax_return_signed = 'Send to India to file' (will update, rows_updated = 1); financials_confirmed is NOT in
-- production at all (the 2026-08-26 seed was never run there) so it reports 0 - harmless; the wording is fixed for whenever it is seeded.

WITH a AS (
  UPDATE catalog_entries
     SET metadata = jsonb_set(metadata, '{next_step}', to_jsonb('Do the final pass on the client-confirmed financials'::text)),
         updated_at = now()
   WHERE catalog_id = 'action_events' AND slug = 'financials_confirmed'
     AND metadata->>'next_step' = 'Do the final pass on the client-confirmed financials, then send to the accountant'
   RETURNING slug
), b AS (
  UPDATE catalog_entries
     SET metadata = jsonb_set(metadata, '{next_step}', to_jsonb('File the signed tax return'::text)),
         updated_at = now()
   WHERE catalog_id = 'action_events' AND slug = 'tax_return_signed'
     AND metadata->>'next_step' = 'Send to India to file'
   RETURNING slug
)
SELECT 'financials_confirmed' AS row_id, (SELECT count(*) FROM a) AS rows_updated
UNION ALL SELECT 'tax_return_signed', (SELECT count(*) FROM b);
