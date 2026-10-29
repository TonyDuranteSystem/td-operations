-- UNDO of 20261029-0200-formation-upload-box-storage-hints.sql: removes `storageHint` AND `documentType` from the three Company Formation upload boxes
-- (Articles / fax confirmation / EIN letter), putting them back to untyped boxes. The workspace then behaves as before this change (no "Document type" list in
-- the boxes; the upload route keeps assigning the type by stage from FORMATION_UPLOAD_TYPES), and the Storage pop-up no longer knows these boxes.
UPDATE pipeline_stages ps
   SET stage_layout = jsonb_set(
         ps.stage_layout,
         '{components}',
         (SELECT jsonb_agg(CASE WHEN c->>'type' = 'document_upload' THEN c - 'storageHint' - 'documentType' ELSE c END ORDER BY ord)
            FROM jsonb_array_elements(ps.stage_layout->'components') WITH ORDINALITY AS t(c, ord)))
 WHERE ps.service_type = 'Company Formation' AND ps.stage_name IN ('Filed with State', 'SS-4 Signed', 'EIN Received');
