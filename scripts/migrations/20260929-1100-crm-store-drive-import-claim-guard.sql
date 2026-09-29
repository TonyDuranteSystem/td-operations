-- CRM Store — "Move this company": a batch may only claim files while its move is still MOVING (bug-hunter round 2:
-- a batch that passed its status check could claim files after Undo had started). Sandbox first (R105). Idempotent.
BEGIN;
CREATE OR REPLACE FUNCTION public.store_import_claim(p_run_id uuid, p_limit integer)
RETURNS SETOF public.store_import_items LANGUAGE sql AS $$
  UPDATE public.store_import_items i SET status = 'working', updated_at = now()
   WHERE i.id IN (
     SELECT it.id FROM public.store_import_items it
       JOIN public.store_import_runs r ON r.id = it.run_id AND r.status = 'moving'
      WHERE it.run_id = p_run_id
        AND (it.status = 'pending' OR (it.status = 'working' AND it.updated_at < now() - interval '5 minutes'))
      ORDER BY it.drive_path, it.name
      LIMIT greatest(p_limit, 1)
      FOR UPDATE OF it SKIP LOCKED)
  RETURNING i.*
$$;
REVOKE ALL ON FUNCTION public.store_import_claim(uuid, integer) FROM PUBLIC, anon, authenticated;
COMMIT;
