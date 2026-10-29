-- ITIN workspace (dev job e3215801, Antonio 2026-10-28: "make the system flexible instead of hardcoded"). DATA change only, no schema change. Idempotent.
--
-- The "a workspace step is waiting for this document" pop-up and the step-by-step guide no longer use a hand-written table in code: they read each
-- upload box's own `storageHint` in the stage layout (lib/flows/stage-layout.ts StageBoxStorageHint, lib/flows/storage-step-rules.ts buildStepHints).
-- This moves what the old code table said about the three ITIN boxes INTO the boxes (same words, same stages, same types) and adds the one
-- stage the table missed: "Client Signing" for the signed package (4 of the 9 real open ITIN cases sit there; the package can arrive before anyone moves the case on).
--
--   Documents Received  box -> the signed package from the client      stages: Client Signing, Shipped, Documents Received
--   Submitted to IRS    box -> the mailing receipt                      stage:  Submitted to IRS
--   ITIN Approved       box -> the IRS approval letter (CP565)          stages: Submitted to IRS, IRS Processing, ITIN Approved
--
-- UNDO: scripts/migrations/20261029-0100-itin-upload-box-storage-hints.UNDO.sql (removes the `storageHint` key from those three boxes)

DO $$
DECLARE
  n_boxes integer;
BEGIN
  SELECT count(*) INTO n_boxes FROM pipeline_stages ps, LATERAL jsonb_array_elements(ps.stage_layout->'components') c
   WHERE ps.service_type = 'ITIN' AND c->>'type' = 'document_upload'
     AND ((ps.stage_name = 'Documents Received' AND c->>'documentType' = 'itin_application')
       OR (ps.stage_name = 'Submitted to IRS'   AND c->>'documentType' = 'receipt')
       OR (ps.stage_name = 'ITIN Approved'      AND c->>'documentType' = 'itin_letter'));
  IF n_boxes <> 3 THEN
    RAISE EXCEPTION 'itin-box-storage-hints: expected the 3 typed ITIN upload boxes (run 20261028-1400 first), found %', n_boxes;
  END IF;
END $$;

UPDATE pipeline_stages ps
   SET stage_layout = jsonb_set(
         ps.stage_layout,
         '{components}',
         (SELECT jsonb_agg(
                   CASE WHEN c->>'type' = 'document_upload' THEN c || jsonb_build_object('storageHint', v.hint) ELSE c END
                   ORDER BY ord)
            FROM jsonb_array_elements(ps.stage_layout->'components') WITH ORDINALITY AS t(c, ord)))
  FROM (VALUES
    ('Documents Received', $h$
      {"asks": "the signed package received from the client",
       "acceptsTypes": ["form_w_7"],
       "folderKind": "itin",
       "otherDocumentCounts": true,
       "fromStages": ["Client Signing", "Shipped", "Documents Received"],
       "effects": ["attach it to the case as the received package", "move the case on to the CAA review"]}
    $h$::jsonb),
    ('Submitted to IRS', $h$
      {"asks": "the mailing receipt for the package sent to the IRS",
       "folderKind": "itin",
       "typeNeedsFolder": true,
       "otherDocumentCounts": true,
       "fromStages": ["Submitted to IRS"],
       "effects": ["attach it to the case as the mailing receipt"]}
    $h$::jsonb),
    ('ITIN Approved', $h$
      {"asks": "the IRS approval letter (CP565)",
       "acceptsTypes": ["itin_cp565", "itin_letter_client_received"],
       "folderKind": "itin",
       "otherDocumentCounts": true,
       "fromStages": ["Submitted to IRS", "IRS Processing", "ITIN Approved"],
       "effects": [
         {"text": "read the ITIN from the letter and save it on the contact", "key": "read_itin"},
         "show the letter to the client",
         "tell the client in the portal (a message and a notification; an email only if they do not have the app)",
         "close the case"]}
    $h$::jsonb)
  ) AS v(stage, hint)
 WHERE ps.service_type = 'ITIN' AND ps.stage_name = v.stage;

-- verify
DO $$
DECLARE
  n_hinted integer;
BEGIN
  SELECT count(*) INTO n_hinted FROM pipeline_stages ps, LATERAL jsonb_array_elements(ps.stage_layout->'components') c
   WHERE ps.service_type = 'ITIN' AND c->>'type' = 'document_upload' AND c ? 'storageHint';
  IF n_hinted <> 3 THEN RAISE EXCEPTION 'itin-box-storage-hints: expected 3 boxes with a storageHint, found %', n_hinted; END IF;
END $$;
