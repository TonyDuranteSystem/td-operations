-- UNDO of 20261029-2200-change-name-upload-box-storage-hints.sql: removes `storageHint` AND `documentType` from the Company Change Name upload box at
-- "Waiting for the state", putting it back to an untyped box. The workspace then behaves as before this change (no "Document type" list in the box; the
-- upload route keeps giving the state's stamped document the generic client type), and the Storage pop-up no longer knows this box.
UPDATE pipeline_stages ps
   SET stage_layout = jsonb_set(
         ps.stage_layout,
         '{components}',
         (SELECT jsonb_agg(CASE WHEN c->>'type' = 'document_upload' THEN c - 'storageHint' - 'documentType' ELSE c END ORDER BY ord)
            FROM jsonb_array_elements(ps.stage_layout->'components') WITH ORDINALITY AS t(c, ord)))
 WHERE ps.service_type = 'Company Change Name' AND ps.stage_name = 'Waiting for the state';
