-- Company Change Name workspace (dev job e3215801, Antonio 2026-10-29: "change name", then "using this wording"). DATA change only, no schema change. Idempotent.
--
-- The "a workspace step is waiting for this document" pop-up and the step-by-step guide read each upload box's own `documentType` + `storageHint` in the stage
-- layout (lib/flows/stage-layout.ts StageBoxStorageHint, lib/flows/storage-step-rules.ts buildStepHints). This types ONE Company Change Name upload box:
--
--   Waiting for the state  box "Upload the state's stamped document"  -> the state's stamped document approving the new name
--
-- Why this box: "Apply new name" (lib/operations/change-name-apply.ts) refuses until a document stamped with this step is on the case, and only a document
-- stamped with this step is shown to the client (lib/flows/flow-doc-visibility.ts). A file saved straight into Storage has neither.
-- The type is "Other document" — the type the workspace already gives this file (lib/crm-store/save-for-account.ts GENERIC_CLIENT_TYPE), so no saved file changes type.
-- The rule counts only a file going into a COMPANY-kind folder ("1. Company"): a Change Name case belongs to the company AND to the person, and the
-- "company" folder kind exists only in company storages, so a file saved in the person's own storage never raises it. It fires only while the case is at
-- "Waiting for the state". The other box of this service ("File the form with the state", proof of filing) is left alone: nothing depends on its stamp, and two
-- boxes cannot share one type.
--
-- UNDO: scripts/migrations/20261029-2200-change-name-upload-box-storage-hints.UNDO.sql (removes `storageHint` and `documentType` from that box)

DO $$
DECLARE
  n_boxes integer;
  n_types integer;
BEGIN
  SELECT count(*) INTO n_boxes FROM pipeline_stages ps, LATERAL jsonb_array_elements(ps.stage_layout->'components') c
   WHERE ps.service_type = 'Company Change Name' AND ps.stage_name = 'Waiting for the state'
     AND c->>'type' = 'document_upload' AND c->>'label' = 'Upload the state''s stamped document';
  IF n_boxes <> 1 THEN
    RAISE EXCEPTION 'change-name-box-storage-hints: expected the 1 Company Change Name upload box "Upload the state''s stamped document", found %', n_boxes;
  END IF;
  SELECT count(*) INTO n_types FROM catalog_entries
   WHERE catalog_id = 'storage_document_types' AND status = 'active' AND slug = 'other_document';
  IF n_types <> 1 THEN
    RAISE EXCEPTION 'change-name-box-storage-hints: expected the active Storage document type other_document, found %', n_types;
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
    ('Waiting for the state', 'other_document', $h$
      {"asks": "the state's stamped document approving the new name",
       "folderKind": "company",
       "typeNeedsFolder": true,
       "effects": ["attach it to the case (\"Apply new name\" needs it)",
                   "show it to the client",
                   "rename it \"State approved name change – company name\" and file it in the \"1. Company\" folder"]}
    $h$::jsonb)
  ) AS v(stage, doc_type, hint)
 WHERE ps.service_type = 'Company Change Name' AND ps.stage_name = v.stage;

-- verify
DO $$
DECLARE
  n_hinted integer;
BEGIN
  SELECT count(*) INTO n_hinted FROM pipeline_stages ps, LATERAL jsonb_array_elements(ps.stage_layout->'components') c
   WHERE ps.service_type = 'Company Change Name' AND c->>'type' = 'document_upload' AND c ? 'storageHint' AND c ? 'documentType';
  IF n_hinted <> 1 THEN RAISE EXCEPTION 'change-name-box-storage-hints: expected 1 box with a documentType and a storageHint, found %', n_hinted; END IF;
END $$;
