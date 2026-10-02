-- UNDO for 20261002-2310-renewal-workspace-layouts.sql — puts back the saved workspace layouts of the renewal steps.
BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE public.pipeline_stages ps
   SET stage_layout = b.stage_layout
  FROM public._n1a_c0_stage_layout_backup b
 WHERE ps.id = b.stage_id;

DROP TABLE IF EXISTS public._n1a_c0_stage_layout_backup;

COMMIT;
