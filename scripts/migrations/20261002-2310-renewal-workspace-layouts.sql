-- N1a C0 follow-up (bug-hunter #2, 2026-10-02): the RA renewal / annual report WORKSPACE had its own receipt upload
-- and a "Mark as Completed" button. Since 20261002-2300-renewal-close-guard.sql only Mark Filed on the Calendar can
-- close these jobs, so that upload became a half-filing (receipt saved, job stuck) and the button a dead end.
--
-- This file rewrites the workspace layout of every NON-final step of the two renewal services (whatever the step
-- names are in this environment): it removes the upload and the action buttons, and puts a notice + a link to the
-- Calendar at the top. Everything else (info, Harbor / Secretary of State link, documents, chat) stays. The final
-- step's layout is untouched. The old layouts are kept in _n1a_c0_stage_layout_backup so the UNDO restores them.
-- Safe to re-run (a step that already has the Calendar link is skipped).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public._n1a_c0_stage_layout_backup (
  stage_id     uuid PRIMARY KEY,
  service_type text NOT NULL,
  stage_name   text NOT NULL,
  stage_layout jsonb,
  saved_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public._n1a_c0_stage_layout_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._n1a_c0_stage_layout_backup FROM PUBLIC, anon, authenticated;

WITH targets AS (
  SELECT ps.id, ps.service_type, ps.stage_name, ps.stage_layout
    FROM public.pipeline_stages ps
   WHERE ps.service_type IN ('State RA Renewal', 'State Annual Report')
     AND ps.stage_order < (SELECT max(p2.stage_order) FROM public.pipeline_stages p2 WHERE p2.service_type = ps.service_type)
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(ps.stage_layout->'components', '[]'::jsonb)) c
        WHERE c->>'type' = 'external_link' AND c->>'url' = '/calendar')
), saved AS (
  INSERT INTO public._n1a_c0_stage_layout_backup (stage_id, service_type, stage_name, stage_layout)
  SELECT id, service_type, stage_name, stage_layout FROM targets
  ON CONFLICT (stage_id) DO NOTHING
  RETURNING stage_id
)
UPDATE public.pipeline_stages ps
   SET stage_layout = jsonb_build_object(
         'description',
         'File it with Mark Filed on the Calendar — it saves the receipt, closes this job and moves the next date.',
         'components',
         jsonb_build_array(
           jsonb_build_object('type', 'waiting_notice',
                              'label', 'Renewals are filed only from the Calendar: open it, find this company and press "Mark Filed".'),
           jsonb_build_object('type', 'external_link', 'url', '/calendar', 'label', 'Open the Calendar')
         )
         || COALESCE((
              SELECT jsonb_agg(c ORDER BY ord)
                FROM jsonb_array_elements(COALESCE(t.stage_layout->'components', '[]'::jsonb)) WITH ORDINALITY AS x(c, ord)
               WHERE c->>'type' NOT IN ('document_upload', 'action_buttons')), '[]'::jsonb)
       )
  FROM targets t
 WHERE ps.id = t.id;

COMMIT;
