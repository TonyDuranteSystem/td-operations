-- UNDO for 20261018-1800-financials-confirmed-next-step-no-accountant.sql (restores the old wording; reports rows changed).
WITH a AS (
  UPDATE catalog_entries
     SET metadata = jsonb_set(metadata, '{next_step}', to_jsonb('Do the final pass on the client-confirmed financials, then send to the accountant'::text)),
         updated_at = now()
   WHERE catalog_id = 'action_events' AND slug = 'financials_confirmed'
     AND metadata->>'next_step' = 'Do the final pass on the client-confirmed financials'
   RETURNING slug
), b AS (
  UPDATE catalog_entries
     SET metadata = jsonb_set(metadata, '{next_step}', to_jsonb('Send to India to file'::text)),
         updated_at = now()
   WHERE catalog_id = 'action_events' AND slug = 'tax_return_signed'
     AND metadata->>'next_step' = 'File the signed tax return'
   RETURNING slug
)
SELECT 'financials_confirmed' AS row_id, (SELECT count(*) FROM a) AS rows_restored
UNION ALL SELECT 'tax_return_signed', (SELECT count(*) FROM b);
