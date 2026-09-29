-- CRM Store — "Move this company" hardening (bug-hunter round, 2026-09-29). Sandbox first (R105). Idempotent.
--   · items get a 'working' state: a batch CLAIMS its files (FOR UPDATE SKIP LOCKED), so two tabs never move the
--     same file; a claim older than 5 minutes (a request that died) is taken over.
--   · runs get an 'undoing' state: undo stops the batches before it reads the ledger.
BEGIN;

ALTER TABLE public.store_import_items DROP CONSTRAINT IF EXISTS store_import_items_status_check;
ALTER TABLE public.store_import_items ADD CONSTRAINT store_import_items_status_check
  CHECK (status IN ('pending','working','done','merged','skipped','failed'));

ALTER TABLE public.store_import_runs DROP CONSTRAINT IF EXISTS store_import_runs_status_check;
ALTER TABLE public.store_import_runs ADD CONSTRAINT store_import_runs_status_check
  CHECK (status IN ('scanning','moving','undoing','done','incomplete','failed','rolled_back'));

-- the open-run index covers 'undoing' too (no new move while an undo runs)
DROP INDEX IF EXISTS public.uq_store_import_runs_open;
CREATE UNIQUE INDEX uq_store_import_runs_open
  ON public.store_import_runs (account_id) WHERE status IN ('scanning','moving','undoing');

CREATE OR REPLACE FUNCTION public.store_import_claim(p_run_id uuid, p_limit integer)
RETURNS SETOF public.store_import_items LANGUAGE sql AS $$
  UPDATE public.store_import_items i SET status = 'working', updated_at = now()
   WHERE i.id IN (
     SELECT id FROM public.store_import_items
      WHERE run_id = p_run_id
        AND (status = 'pending' OR (status = 'working' AND updated_at < now() - interval '5 minutes'))
      ORDER BY drive_path, name
      LIMIT greatest(p_limit, 1)
      FOR UPDATE SKIP LOCKED)
  RETURNING i.*
$$;
REVOKE ALL ON FUNCTION public.store_import_claim(uuid, integer) FROM PUBLIC, anon, authenticated;

COMMIT;
