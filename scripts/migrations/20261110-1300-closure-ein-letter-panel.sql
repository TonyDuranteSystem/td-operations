-- Company Closure, "IRS Closure": the EIN closure letter is made for you (dev job a6bbea09; Antonio 2026-11-10: "the system must create it automatically with the letter … and merge the letter with a copy of the EIN letter").
--
-- WHAT: the layout of the Company Closure step "IRS Closure" gets one more box, `ein_closure_letter_panel`, right under the waiting notice: it makes the letter to the IRS,
--   attaches a copy of the company's EIN letter and saves the package on the job (code: lib/closure/ein-closure-package.ts, app/api/flows/[id]/ein-closure-letter).
--   The upload box ("the letter as sent"), the required tracking number, the documents list, the chat and the advance button are untouched. The step's description
--   sentence is changed to point at the new box. Nothing else.
-- SAFE TO RE-RUN: does nothing when the box is already there. It refuses to run if the step does not look the way production read on 2026-11-10 (first box = the waiting notice).
-- UNDO: 20261110-1300-closure-ein-letter-panel.UNDO.sql removes the box and puts the old sentence back.
-- Apply to SANDBOX first (node scripts/apply-migration.js); production only after the code is merged and live, on Antonio's word (he runs it).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"closure-ein-letter-panel-migration"}', true);

DO $do$
DECLARE
  v_layout jsonb;
  v_comps  jsonb;
  v_new    jsonb;
  v_rows   int;
BEGIN
  SELECT stage_layout INTO v_layout
    FROM public.pipeline_stages
   WHERE service_type = 'Company Closure' AND stage_name = 'IRS Closure';
  IF v_layout IS NULL THEN
    RAISE EXCEPTION 'closure-ein-letter-panel: the Company Closure step "IRS Closure" has no layout';
  END IF;
  v_comps := v_layout->'components';
  IF jsonb_typeof(v_comps) <> 'array' OR v_comps->0->>'type' IS DISTINCT FROM 'waiting_notice' THEN
    RAISE EXCEPTION 'closure-ein-letter-panel: the "IRS Closure" layout is not the expected shape (first box must be the waiting notice) — nothing changed';
  END IF;
  IF v_comps @> '[{"type":"ein_closure_letter_panel"}]'::jsonb THEN
    RAISE NOTICE 'closure-ein-letter-panel: already there — nothing to do';
    RETURN;
  END IF;

  v_new := jsonb_build_array(v_comps->0)
        || jsonb_build_array(jsonb_build_object('type', 'ein_closure_letter_panel'))
        || COALESCE((SELECT jsonb_agg(e ORDER BY ord) FROM jsonb_array_elements(v_comps) WITH ORDINALITY AS t(e, ord) WHERE ord > 1), '[]'::jsonb);

  UPDATE public.pipeline_stages
     SET stage_layout = jsonb_set(
           jsonb_set(v_layout, '{components}', v_new),
           '{description}',
           to_jsonb('Make the EIN closure letter with the box below, print it and mail it to the IRS (Cincinnati, OH). If a final tax return is needed, India prepares it and it goes in the same envelope. Save the tracking number below — the next step stays locked until it is saved.'::text))
   WHERE service_type = 'Company Closure' AND stage_name = 'IRS Closure';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'closure-ein-letter-panel: expected to change exactly 1 step, changed %', v_rows;
  END IF;
  RAISE NOTICE 'closure-ein-letter-panel: box added to "IRS Closure"';
END
$do$;

COMMIT;
