-- ITIN workspace (dev job e3215801, Antonio 2026-10-28). Two DATA changes, no schema change. Idempotent.
--
-- 1) The old generic stage email is switched OFF for ITIN "Submitted to IRS" and "ITIN Approved". Antonio's rule: the client gets the MESSAGE in
--    the portal (+ bell/push); email only as the "you have an unread message" nudge for a client without push. "Submitted to IRS" keeps its
--    portal chat message (notify_client_chat stays true); the letter upload sends the portal message for "ITIN Approved".
--    Scoped by BOTH service_type AND stage_name on purpose (a stage-name-only scope has silently rotted before — see the 20260908 migration).
--
-- 2) The three ITIN upload boxes carry their DEFAULT Storage document type in the stage layout (`documentType`, a catalog slug). A box with it
--    shows a type picker (the Storage list for where the file lands, this one pre-selected) and the upload must carry a type — the Storage rule.
--      Documents Received  -> itin_application   (the signed package scan)
--      Submitted to IRS    -> receipt            (the mailing receipt / tracking)
--      ITIN Approved       -> itin_letter        (the IRS approval letter, CP565)
--    A slug missing from the catalog only means no default is pre-selected (the person chooses). A request that sends NO type at all (a browser tab
--    opened before the picker existed) is then refused with a "reload the page" sentence, because the server applies the box default (it never saves "Other document").
--
-- UNDO: scripts/migrations/20261028-1400-itin-stage-emails-off-and-upload-box-types.UNDO.sql

DO $$
DECLARE
  n_stages integer;
BEGIN
  SELECT count(*) INTO n_stages FROM pipeline_stages
   WHERE service_type = 'ITIN' AND stage_name IN ('Documents Received', 'Submitted to IRS', 'ITIN Approved');
  IF n_stages <> 3 THEN
    RAISE EXCEPTION 'itin-stage-emails-off: expected the 3 ITIN stages, found %', n_stages;
  END IF;
END $$;

-- 1) stage emails off
UPDATE pipeline_stages
   SET notify_client_email = false
 WHERE service_type = 'ITIN' AND stage_name IN ('Submitted to IRS', 'ITIN Approved');

-- 2) default Storage type on each ITIN upload box
UPDATE pipeline_stages ps
   SET stage_layout = jsonb_set(
         ps.stage_layout,
         '{components}',
         (SELECT jsonb_agg(
                   CASE WHEN c->>'type' = 'document_upload' THEN c || jsonb_build_object('documentType', v.slug) ELSE c END
                   ORDER BY ord)
            FROM jsonb_array_elements(ps.stage_layout->'components') WITH ORDINALITY AS t(c, ord)))
  FROM (VALUES
         ('Documents Received', 'itin_application'),
         ('Submitted to IRS',   'receipt'),
         ('ITIN Approved',      'itin_letter')
       ) AS v(stage, slug)
 WHERE ps.service_type = 'ITIN' AND ps.stage_name = v.stage;

-- verify
DO $$
DECLARE
  emails_on integer;
  boxes_typed integer;
BEGIN
  SELECT count(*) INTO emails_on FROM pipeline_stages
   WHERE service_type = 'ITIN' AND stage_name IN ('Submitted to IRS', 'ITIN Approved') AND notify_client_email IS DISTINCT FROM false;
  IF emails_on <> 0 THEN RAISE EXCEPTION 'itin-stage-emails-off: % stage email(s) still on', emails_on; END IF;

  SELECT count(*) INTO boxes_typed FROM pipeline_stages ps,
         LATERAL jsonb_array_elements(ps.stage_layout->'components') c
   WHERE ps.service_type = 'ITIN' AND c->>'type' = 'document_upload' AND coalesce(c->>'documentType', '') <> '';
  IF boxes_typed <> 3 THEN RAISE EXCEPTION 'itin-stage-emails-off: expected 3 typed upload boxes, found %', boxes_typed; END IF;

  -- a default that the catalog does not list is only a notice: the box then asks the person to choose
  IF EXISTS (SELECT 1 FROM (VALUES ('itin_application'), ('receipt'), ('itin_letter')) AS d(slug)
              WHERE NOT EXISTS (SELECT 1 FROM catalog_entries WHERE catalog_id = 'storage_document_types' AND slug = d.slug AND status = 'active')) THEN
    RAISE NOTICE 'itin-stage-emails-off: a default type is not in this catalog (fine — the box will ask the person to choose)';
  END IF;
END $$;
