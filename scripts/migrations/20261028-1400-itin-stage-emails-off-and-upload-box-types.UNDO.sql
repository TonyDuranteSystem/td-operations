-- UNDO of 20261028-1400-itin-stage-emails-off-and-upload-box-types.sql (dev job e3215801). Idempotent.
-- Puts the two stage emails back ON and removes the default type from the three ITIN upload boxes (the picker then no longer shows).

UPDATE pipeline_stages
   SET notify_client_email = true
 WHERE service_type = 'ITIN' AND stage_name IN ('Submitted to IRS', 'ITIN Approved');

UPDATE pipeline_stages ps
   SET stage_layout = jsonb_set(
         ps.stage_layout,
         '{components}',
         (SELECT jsonb_agg(CASE WHEN c->>'type' = 'document_upload' THEN c - 'documentType' ELSE c END ORDER BY ord)
            FROM jsonb_array_elements(ps.stage_layout->'components') WITH ORDINALITY AS t(c, ord)))
 WHERE ps.service_type = 'ITIN' AND ps.stage_name IN ('Documents Received', 'Submitted to IRS', 'ITIN Approved');
