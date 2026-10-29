-- Company Formation workspace (dev job e3215801, Antonio 2026-10-29: "ok" to the wording below; "make the system flexible instead of hardcoded"). DATA change only, no schema change. Idempotent.
--
-- The "a workspace step is waiting for this document" pop-up and the step-by-step guide read each upload box's own `documentType` + `storageHint` in the stage
-- layout (lib/flows/stage-layout.ts StageBoxStorageHint, lib/flows/storage-step-rules.ts buildStepHints). The three Company Formation upload boxes carried neither,
-- so a file saved straight into Storage never raised the pop-up. This types them (the SAME types the workspace already assigns by stage in
-- lib/crm-store/formation-pilot.ts FORMATION_UPLOAD_TYPES, so no saved file changes type) and gives each its words:
--
--   Filed with State  box -> the Articles of Organization from the state   fires only while the case is at "Filed with State"
--   SS-4 Signed       box -> the fax confirmation for the SS-4            fires only while the case is at "SS-4 Signed"
--   EIN Received      box -> the IRS EIN letter (CP 575)                  fires at "SS-4 Sent to IRS" (the letter arrives while we wait) and "EIN Received"
--
-- Each typed box also shows the "Document type" list in the workspace (the Storage rule), pre-set to the type above — the same as the ITIN boxes.
--
-- UNDO: scripts/migrations/20261029-0200-formation-upload-box-storage-hints.UNDO.sql (removes `storageHint` and `documentType` from those three boxes)

DO $$
DECLARE
  n_boxes integer;
  n_types integer;
BEGIN
  SELECT count(*) INTO n_boxes FROM pipeline_stages ps, LATERAL jsonb_array_elements(ps.stage_layout->'components') c
   WHERE ps.service_type = 'Company Formation' AND c->>'type' = 'document_upload'
     AND ((ps.stage_name = 'Filed with State' AND c->>'label' = 'Upload Articles of Organization')
       OR (ps.stage_name = 'SS-4 Signed'      AND c->>'label' = 'Upload fax confirmation/tracking')
       OR (ps.stage_name = 'EIN Received'     AND c->>'label' = 'Upload EIN Letter (CP 575)'));
  IF n_boxes <> 3 THEN
    RAISE EXCEPTION 'formation-box-storage-hints: expected the 3 Company Formation upload boxes (Articles / fax confirmation / EIN letter), found %', n_boxes;
  END IF;
  SELECT count(*) INTO n_types FROM catalog_entries
   WHERE catalog_id = 'storage_document_types' AND status = 'active' AND slug IN ('articles_of_organization', 'fax_confirmation', 'ein_letter_irs');
  IF n_types <> 3 THEN
    RAISE EXCEPTION 'formation-box-storage-hints: expected the 3 active Storage document types articles_of_organization / fax_confirmation / ein_letter_irs, found %', n_types;
  END IF;
END $$;

UPDATE pipeline_stages ps
   SET stage_layout = jsonb_set(
         ps.stage_layout,
         '{components}',
         (SELECT jsonb_agg(
                   CASE WHEN c->>'type' = 'document_upload'
                        THEN c || jsonb_build_object('documentType', v.doc_type, 'storageHint', v.hint)
                        ELSE c END
                   ORDER BY ord)
            FROM jsonb_array_elements(ps.stage_layout->'components') WITH ORDINALITY AS t(c, ord)))
  FROM (VALUES
    ('Filed with State', 'articles_of_organization', $h$
      {"asks": "the Articles of Organization from the state",
       "effects": ["ask for the company's legal name, state, LLC type and formation date",
                   "save the file on the case",
                   "move the case on to Articles Received and create the company"]}
    $h$::jsonb),
    ('SS-4 Signed', 'fax_confirmation', $h$
      {"asks": "the fax confirmation for the SS-4 sent to the IRS",
       "effects": ["save the file on the case",
                   "move the case on to SS-4 Sent to IRS"]}
    $h$::jsonb),
    ('EIN Received', 'ein_letter_irs', $h$
      {"asks": "the IRS EIN letter (CP 575)",
       "fromStages": ["SS-4 Sent to IRS", "EIN Received"],
       "effects": ["rename it \"EIN Official – company name\" and file it in the \"1. Company\" folder",
                   "save the file on the case"]}
    $h$::jsonb)
  ) AS v(stage, doc_type, hint)
 WHERE ps.service_type = 'Company Formation' AND ps.stage_name = v.stage;

-- verify
DO $$
DECLARE
  n_hinted integer;
BEGIN
  SELECT count(*) INTO n_hinted FROM pipeline_stages ps, LATERAL jsonb_array_elements(ps.stage_layout->'components') c
   WHERE ps.service_type = 'Company Formation' AND c->>'type' = 'document_upload' AND c ? 'storageHint' AND c ? 'documentType';
  IF n_hinted <> 3 THEN RAISE EXCEPTION 'formation-box-storage-hints: expected 3 boxes with a documentType and a storageHint, found %', n_hinted; END IF;
END $$;
