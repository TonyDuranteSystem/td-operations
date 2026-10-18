-- dev job 264bb882 (Stop Drive S1b) -- the accountant hand-off is RETIRED (Antonio, 2026-10-18).
-- Two live catalog rows still tell staff to hand a return to the accountant / India:
--   action_events/financials_confirmed : "...then send to the accountant"
--   action_events/tax_return_signed    : "Send to India to file"
-- Only the wording of next_step changes; nothing else in the rows, no tax_returns data. Idempotent: a row that no longer
-- has the old wording is left alone. It REPORTS how many rows changed and raises a WARNING for any row that did not match.
--
-- Read-only check to run FIRST (expect exactly these two next_step values):
--   SELECT slug, metadata->>'next_step' AS next_step FROM catalog_entries
--    WHERE catalog_id = 'action_events' AND slug IN ('financials_confirmed','tax_return_signed');

DO $$
DECLARE
  n int;
BEGIN
  UPDATE catalog_entries
     SET metadata = jsonb_set(metadata, '{next_step}', to_jsonb('Do the final pass on the client-confirmed financials'::text)),
         updated_at = now()
   WHERE catalog_id = 'action_events' AND slug = 'financials_confirmed'
     AND metadata->>'next_step' = 'Do the final pass on the client-confirmed financials, then send to the accountant';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN RAISE NOTICE 'financials_confirmed: 1 row updated';
  ELSE RAISE WARNING 'financials_confirmed: % rows updated (expected 1) - check the current next_step wording', n; END IF;

  UPDATE catalog_entries
     SET metadata = jsonb_set(metadata, '{next_step}', to_jsonb('File the signed tax return'::text)),
         updated_at = now()
   WHERE catalog_id = 'action_events' AND slug = 'tax_return_signed'
     AND metadata->>'next_step' = 'Send to India to file';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN RAISE NOTICE 'tax_return_signed: 1 row updated';
  ELSE RAISE WARNING 'tax_return_signed: % rows updated (expected 1) - check the current next_step wording', n; END IF;
END $$;
