-- UNDO for 20261016-1200-step-wait-kinds-catalog.sql.
-- 1. Any step that uses a kind added after the seed is re-pointed to its behaviour's seed kind (date -> 'date', anything else -> 'outside'),
--    because the old 5-value CHECK cannot hold a custom slug. 2. The shape rule is replaced by the old CHECK.
-- The catalog rows are left in place (harmless once the OLD code is back, since nothing reads them). ROLL THE CODE BACK TOGETHER WITH THIS UNDO: with the new
-- code still deployed the Service Catalog's "Waiting-on list" would stay switched on and offer kinds the restored 5-value CHECK refuses.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"wait-kinds-undo"}', true);

UPDATE public.pipeline_stages ps
SET waiting_on = CASE
  WHEN COALESCE((SELECT e.metadata->>'behaviour' FROM public.catalog_entries e WHERE e.catalog_id = 'step_wait_kinds' AND e.slug = ps.waiting_on), 'other') = 'date'
    THEN 'date' ELSE 'outside' END
WHERE ps.waiting_on IS NOT NULL AND ps.waiting_on NOT IN ('us', 'client', 'outside', 'date', 'none');

ALTER TABLE public.pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_waiting_on_shape;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_stages_waiting_on_check') THEN
    ALTER TABLE public.pipeline_stages ADD CONSTRAINT pipeline_stages_waiting_on_check
      CHECK (waiting_on IS NULL OR waiting_on IN ('us', 'client', 'outside', 'date', 'none'));
  END IF;
END $$;

COMMENT ON COLUMN public.pipeline_stages.waiting_on IS
  'N1a C2: who must act next while a job sits on this step — us | client | outside | date | none. NULL = not set.';
COMMIT;
