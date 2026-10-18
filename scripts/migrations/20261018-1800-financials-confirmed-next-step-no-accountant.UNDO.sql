-- UNDO for 20261018-1800-financials-confirmed-next-step-no-accountant.sql (restores the old wording).
UPDATE catalog_entries
   SET metadata = jsonb_set(metadata, '{next_step}', to_jsonb('Do the final pass on the client-confirmed financials, then send to the accountant'::text)),
       updated_at = now()
 WHERE catalog_id = 'action_events'
   AND slug = 'financials_confirmed'
   AND metadata->>'next_step' = 'Do the final pass on the client-confirmed financials';
