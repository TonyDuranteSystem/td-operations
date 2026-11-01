-- UNDO for 20261101-1600-lead-calls-moves-owner-followup.sql. Drops the two new tables and the two new lead columns.
-- Nothing else reads them until the lead window code is deployed, so run this AFTER that code is reverted.
DROP TABLE IF EXISTS public.lead_status_moves;
DROP TABLE IF EXISTS public.lead_calls;
ALTER TABLE public.leads DROP COLUMN IF EXISTS owner;
ALTER TABLE public.leads DROP COLUMN IF EXISTS follow_up_date;
