-- dev job 264bb882 (Stop Drive S1b) -- the accountant hand-off is RETIRED (Antonio, 2026-10-18).
-- The catalog row for the action event "financials_confirmed" still tells staff to "send to the accountant".
-- Only the wording of next_step changes; nothing else in the row, no tax_returns data. Idempotent.
UPDATE catalog_entries
   SET metadata = jsonb_set(metadata, '{next_step}', to_jsonb('Do the final pass on the client-confirmed financials'::text)),
       updated_at = now()
 WHERE catalog_id = 'action_events'
   AND slug = 'financials_confirmed'
   AND metadata->>'next_step' = 'Do the final pass on the client-confirmed financials, then send to the accountant';
