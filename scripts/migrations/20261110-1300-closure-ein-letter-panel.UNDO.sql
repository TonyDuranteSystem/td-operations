-- UNDO of 20261110-1300-closure-ein-letter-panel.sql: removes the `ein_closure_letter_panel` box from the Company Closure step "IRS Closure" and puts the old description sentence back
-- (the sentence production had on 2026-11-10). Re-runnable.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"closure-ein-letter-panel-undo"}', true);

UPDATE public.pipeline_stages
   SET stage_layout = jsonb_set(
         jsonb_set(
           stage_layout,
           '{components}',
           COALESCE((SELECT jsonb_agg(e ORDER BY ord) FROM jsonb_array_elements(stage_layout->'components') WITH ORDINALITY AS t(e, ord) WHERE e->>'type' IS DISTINCT FROM 'ein_closure_letter_panel'), '[]'::jsonb)),
         '{description}',
         to_jsonb('Fill out the EIN closure letter, print it and mail it to the IRS (Cincinnati, OH). If a final tax return is needed, India prepares it and it goes in the same envelope. Save the tracking number below — the next step stays locked until it is saved.'::text))
 WHERE service_type = 'Company Closure' AND stage_name = 'IRS Closure'
   AND stage_layout->'components' @> '[{"type":"ein_closure_letter_panel"}]'::jsonb;

COMMIT;
