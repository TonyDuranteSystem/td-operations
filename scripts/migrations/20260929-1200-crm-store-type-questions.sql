-- CRM Store — document-type questions (2026-09-29, job 685467b5). Sandbox first (R105). Idempotent (safe to re-run).
--   · store_label_key(text): ONE spelling rule for a label — lower case, trimmed, inner spaces collapsed
--     ("Lease  Agreement " = "lease agreement"); the same rule as labelKey() in lib/crm-store/type-names.ts
--   · one OPEN question per label and catalog (two batches never ask the same thing twice)
--   · store_unknown_document_type_names(min): the labels CRM records carry that the storage's document types do
--     not know (by type number or name) and that were never asked about — "Look for unknown labels" + the Drive move
--   · store_document_label_state(label): how many records carry it, whether it was asked, whether a type knows it
BEGIN;

CREATE OR REPLACE FUNCTION public.store_label_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(lower(btrim(coalesce(p, ''))), '\s+', ' ', 'g')
$$;

DROP INDEX IF EXISTS public.uq_catalog_pending_open_value;
CREATE UNIQUE INDEX uq_catalog_pending_open_value
  ON public.catalog_pending_review (catalog_id, public.store_label_key(submitted_value)) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.store_unknown_document_type_names(p_min integer)
RETURNS TABLE (name text, records bigint) LANGUAGE sql STABLE AS $$
  SELECT min(regexp_replace(btrim(d.document_type_name), '\s+', ' ', 'g')) AS name, count(*) AS records
    FROM public.documents d
   WHERE public.store_label_key(d.document_type_name) <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.catalog_entries e
        WHERE e.catalog_id = 'storage_document_types'
          AND (public.store_label_key(e.display_name) = public.store_label_key(d.document_type_name)
               OR (d.document_type_id IS NOT NULL AND e.metadata ? 'legacy_document_type_id'
                   AND (e.metadata->>'legacy_document_type_id') ~ '^[0-9]+$'
                   AND (e.metadata->>'legacy_document_type_id')::int = d.document_type_id)))
     AND NOT EXISTS (
       SELECT 1 FROM public.catalog_pending_review r
        WHERE r.catalog_id = 'storage_document_types' AND public.store_label_key(r.submitted_value) = public.store_label_key(d.document_type_name))
   GROUP BY public.store_label_key(d.document_type_name)
  HAVING count(*) >= greatest(p_min, 1)
   ORDER BY count(*) DESC, 1
$$;

CREATE OR REPLACE FUNCTION public.store_document_label_state(p_label text)
RETURNS TABLE (records bigint, asked boolean, known boolean) LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT count(*) FROM public.documents d WHERE public.store_label_key(d.document_type_name) = public.store_label_key(p_label)),
    EXISTS (SELECT 1 FROM public.catalog_pending_review r
             WHERE r.catalog_id = 'storage_document_types' AND public.store_label_key(r.submitted_value) = public.store_label_key(p_label)),
    EXISTS (SELECT 1 FROM public.catalog_entries e
             WHERE e.catalog_id = 'storage_document_types' AND public.store_label_key(e.display_name) = public.store_label_key(p_label))
$$;

REVOKE ALL ON FUNCTION public.store_unknown_document_type_names(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_document_label_state(text) FROM PUBLIC, anon, authenticated;

COMMIT;
