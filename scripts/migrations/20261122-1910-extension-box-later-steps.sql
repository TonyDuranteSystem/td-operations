-- The extension box on the Tax Return steps AFTER the tax form opens (Antonio, 22 Nov 2026, dev job 6f555c9f).
-- A standalone company tax return has its form open from the moment of payment, so it never waits at "1st Installment Paid". Its extension (optional:
-- file it or mark "no extension needed") is therefore handled on the later steps. This adds the extension box to the workspace layout of each step from
-- "Wizard Available" to "Preparation", just before the chat. The box never moves the job from these steps (a delivered extension is recorded on the tax
-- record and the job stays put); its upload fallback does not auto-advance.
-- Data only (stage_layout JSON); idempotent (a step that already has the box is left alone); a step with no layout is left alone.
-- Apply to the SANDBOX first (node scripts/apply-migration.js <file>); Antonio applies it on production with the rest.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $do$
DECLARE
  r record;
  pos int;
  box jsonb := '{"type": "extension_fax_panel", "label": "Upload Extension Receipt", "autoAdvance": false}'::jsonb;
  new_layout jsonb;
  changed int := 0;
BEGIN
  FOR r IN
    SELECT service_type, stage_name, stage_layout
      FROM public.pipeline_stages
     WHERE service_type = 'Tax Return'
       AND stage_name IN ('Wizard Available', 'Data Submitted', 'Under Review', 'Revision Requested', 'Approved', 'Confirmed', 'Data Received', 'Preparation')
  LOOP
    CONTINUE WHEN r.stage_layout IS NULL OR jsonb_typeof(r.stage_layout->'components') IS DISTINCT FROM 'array';
    CONTINUE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(r.stage_layout->'components') x WHERE x->>'type' = 'extension_fax_panel');

    pos := NULL;
    SELECT (o - 1)::int INTO pos
      FROM jsonb_array_elements(r.stage_layout->'components') WITH ORDINALITY t(c, o)
     WHERE c->>'type' = 'chat'
     ORDER BY o DESC LIMIT 1;

    IF pos IS NULL THEN
      new_layout := jsonb_set(r.stage_layout, '{components}', (r.stage_layout->'components') || jsonb_build_array(box));
    ELSE
      new_layout := jsonb_insert(r.stage_layout, ARRAY['components', pos::text], box);
    END IF;

    UPDATE public.pipeline_stages SET stage_layout = new_layout
     WHERE service_type = r.service_type AND stage_name = r.stage_name;
    changed := changed + 1;
  END LOOP;

  IF (SELECT count(*) FROM public.pipeline_stages
       WHERE service_type = 'Tax Return'
         AND stage_name IN ('Wizard Available', 'Data Submitted', 'Under Review', 'Revision Requested', 'Approved', 'Confirmed', 'Data Received', 'Preparation')
         AND stage_layout IS NOT NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(stage_layout->'components') x WHERE x->>'type' = 'extension_fax_panel')) <> 8 THEN
    RAISE EXCEPTION 'extension-box-later-steps: expected the box on all 8 later steps after the change';
  END IF;
  RAISE NOTICE 'extension-box-later-steps: % step layout(s) changed', changed;
END
$do$;
COMMIT;

SELECT stage_order, stage_name, jsonb_path_exists(stage_layout, '$.components[*] ? (@.type == "extension_fax_panel")') AS has_extension_box
  FROM public.pipeline_stages WHERE service_type = 'Tax Return' ORDER BY stage_order;
