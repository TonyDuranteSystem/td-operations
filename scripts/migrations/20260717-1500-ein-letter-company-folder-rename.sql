-- Formation "EIN Received" stage: file the uploaded EIN letter (CP 575) into
-- the client's "1. Company" Drive subfolder and auto-rename it to
-- "EIN Official – {company_name}" (company_name already carries the entity
-- suffix, e.g. "Acme Holdings LLC").
--
-- Sets two OPTIONAL keys (folder, rename) on the document_upload component of
-- the Company Formation "EIN Received" stage_layout. Both keys are read by
-- app/api/flows/[id]/upload-document/route.ts via parseStageLayout; absent =
-- today's behavior (account root folder, uploaded filename), so no other
-- upload stage is affected.
--
-- The document_upload element is located BY TYPE (not a hardcoded array index)
-- so a future reorder of the components array can't stamp the wrong element.
-- The rename value uses an en-dash (U+2013), matching the spec exactly.
-- Idempotent: re-running re-sets the same two keys.

WITH target AS (
  SELECT ps.id AS stage_id,
         (c.idx - 1) AS elem_idx
  FROM pipeline_stages ps,
       LATERAL jsonb_array_elements(ps.stage_layout -> 'components')
         WITH ORDINALITY AS c(elem, idx)
  WHERE ps.service_type = 'Company Formation'
    AND ps.stage_name = 'EIN Received'
    AND c.elem ->> 'type' = 'document_upload'
)
UPDATE pipeline_stages ps
SET stage_layout = jsonb_set(
      jsonb_set(
        ps.stage_layout,
        ARRAY['components', target.elem_idx::text, 'folder'],
        to_jsonb('1. Company'::text),
        true
      ),
      ARRAY['components', target.elem_idx::text, 'rename'],
      to_jsonb('EIN Official – {company_name}'::text),
      true
    )
FROM target
WHERE ps.id = target.stage_id
RETURNING ps.service_type, ps.stage_name, ps.stage_layout -> 'components';
