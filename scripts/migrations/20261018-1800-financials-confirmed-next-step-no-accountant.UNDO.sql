-- UNDO for 20261018-1800-financials-confirmed-next-step-no-accountant.sql (restores the old wording; reports rows changed).
DO $$
DECLARE
  n int;
BEGIN
  UPDATE catalog_entries
     SET metadata = jsonb_set(metadata, '{next_step}', to_jsonb('Do the final pass on the client-confirmed financials, then send to the accountant'::text)),
         updated_at = now()
   WHERE catalog_id = 'action_events' AND slug = 'financials_confirmed'
     AND metadata->>'next_step' = 'Do the final pass on the client-confirmed financials';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'financials_confirmed: % row(s) restored', n;

  UPDATE catalog_entries
     SET metadata = jsonb_set(metadata, '{next_step}', to_jsonb('Send to India to file'::text)),
         updated_at = now()
   WHERE catalog_id = 'action_events' AND slug = 'tax_return_signed'
     AND metadata->>'next_step' = 'File the signed tax return';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'tax_return_signed: % row(s) restored', n;
END $$;
