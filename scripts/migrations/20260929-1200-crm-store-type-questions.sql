-- CRM Store — document-type questions (2026-09-29, job 685467b5). Sandbox first (R105). Idempotent.
--   · one OPEN question per label and catalog (two batches never ask the same thing twice)
--   · store_unknown_document_type_names(min): the labels CRM records carry that the storage's document types do
--     not know (by type number or name) and that were never asked about — used by the "Look for unknown labels"
--     button and by the Drive move. Read-only.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_pending_open_value
  ON public.catalog_pending_review (catalog_id, lower(btrim(submitted_value))) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.store_unknown_document_type_names(p_min integer)
RETURNS TABLE (name text, records bigint) LANGUAGE sql STABLE AS $$
  SELECT min(btrim(d.document_type_name)) AS name, count(*) AS records
    FROM public.documents d
   WHERE d.document_type_name IS NOT NULL AND btrim(d.document_type_name) <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.catalog_entries e
        WHERE e.catalog_id = 'storage_document_types'
          AND (lower(btrim(e.display_name)) = lower(btrim(d.document_type_name))
               OR (d.document_type_id IS NOT NULL AND e.metadata ? 'legacy_document_type_id'
                   AND (e.metadata->>'legacy_document_type_id') ~ '^[0-9]+$'
                   AND (e.metadata->>'legacy_document_type_id')::int = d.document_type_id)))
     AND NOT EXISTS (
       SELECT 1 FROM public.catalog_pending_review r
        WHERE r.catalog_id = 'storage_document_types' AND lower(btrim(r.submitted_value)) = lower(btrim(d.document_type_name)))
   GROUP BY lower(btrim(d.document_type_name))
  HAVING count(*) >= greatest(p_min, 1)
   ORDER BY count(*) DESC, 1
$$;
REVOKE ALL ON FUNCTION public.store_unknown_document_type_names(integer) FROM PUBLIC, anon, authenticated;

COMMIT;
