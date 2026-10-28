-- UNDO of 20261029-0100-itin-upload-box-storage-hints.sql: removes the `storageHint` key from the ITIN upload boxes (the `documentType` typing stays).
-- After this the "workspace step is waiting" pop-up no longer knows the ITIN boxes' words / extra types / stages (it would only match each box's own
-- stage and type) — run it only together with putting the old code table back.
UPDATE pipeline_stages ps
   SET stage_layout = jsonb_set(
         ps.stage_layout,
         '{components}',
         (SELECT jsonb_agg(CASE WHEN c->>'type' = 'document_upload' THEN c - 'storageHint' ELSE c END ORDER BY ord)
            FROM jsonb_array_elements(ps.stage_layout->'components') WITH ORDINALITY AS t(c, ord)))
 WHERE ps.service_type = 'ITIN' AND ps.stage_name IN ('Documents Received', 'Submitted to IRS', 'ITIN Approved');
