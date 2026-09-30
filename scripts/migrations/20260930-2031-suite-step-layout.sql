-- Suite step — catalog data: add the required "Suite" card to the Company Formation workspace.
-- It goes right after the name command center on "Wizard Submitted" (the step where the client's details are in and
-- the name is being filed — the suite must be decided BEFORE the company is filed with the Secretary of State).
-- Layouts are catalog DATA and can differ between environments: the row is matched by service_type + stage_name and the
-- insert is skipped if the card is already there. Run this BEFORE the code that requires the step is deployed — a formation
-- stuck at this stage with the gate on and no card would have no button to press.
-- (Client Onboarding has no stage_layout — its hand-built workspace carries the choice on the Confirm screen.)

BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE public.pipeline_stages ps
SET stage_layout = jsonb_set(
  ps.stage_layout, '{components}',
  (SELECT jsonb_agg(x.elem ORDER BY x.ord)
   FROM (
     SELECT t.elem, t.ord::numeric AS ord
       FROM jsonb_array_elements(ps.stage_layout->'components') WITH ORDINALITY AS t(elem, ord)
     UNION ALL
     SELECT '{"type":"suite_panel"}'::jsonb, 1.5::numeric
   ) x)
)
WHERE ps.service_type = 'Company Formation'
  AND ps.stage_name = 'Wizard Submitted'
  AND jsonb_typeof(ps.stage_layout->'components') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(ps.stage_layout->'components') e WHERE e->>'type' = 'suite_panel'
  );

-- The Formation gate is useless (and staff get stuck) if the card is not there: fail loudly, change nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Formation' AND stage_name = 'Wizard Submitted')
     AND NOT EXISTS (
       SELECT 1 FROM public.pipeline_stages ps, jsonb_array_elements(
         CASE WHEN jsonb_typeof(ps.stage_layout->'components') = 'array' THEN ps.stage_layout->'components' ELSE '[]'::jsonb END) e
       WHERE ps.service_type = 'Company Formation' AND ps.stage_name = 'Wizard Submitted' AND e->>'type' = 'suite_panel') THEN
    RAISE EXCEPTION 'The Wizard Submitted layout is not a list of components here — the suite card could not be added. Stop and check the layout.';
  END IF;
END $$;

COMMIT;

-- verify (expect suite_panel second):
-- SELECT jsonb_path_query_array(stage_layout, '$.components[*].type') FROM pipeline_stages
--  WHERE service_type='Company Formation' AND stage_name='Wizard Submitted';
