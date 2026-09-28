-- CRM Store — a file marked "Needs review" can never be SHOWN to a client, enforced in the database itself (the
-- screens already refuse it; E2E review 2026-09-28: any other writer must be refused too). Same body as the
-- slice-3/6 function plus that one check. Sandbox first (R105). Idempotent.
BEGIN;
CREATE OR REPLACE FUNCTION public.store_set_published(p_file_id uuid, p_published boolean, p_actor uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  f record;
BEGIN
  SELECT id, owner_id, folder_id, name, state, published, filing_status, document_type, needs_review_at INTO f
    FROM public.store_files WHERE id = p_file_id FOR UPDATE;
  IF NOT FOUND OR f.state <> 'live' THEN RAISE EXCEPTION 'store: only a live file can be published or unpublished'; END IF;
  IF p_published AND public.store_type_staff_only(f.document_type) THEN
    RAISE EXCEPTION 'store: this document type is staff-only and is never shown to clients'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_published AND f.needs_review_at IS NOT NULL THEN
    RAISE EXCEPTION 'store: this file is marked "Needs review" — mark it reviewed before showing it to the client'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_published AND f.filing_status = 'draft' AND coalesce((
       SELECT (metadata->>'draft_never_visible')::boolean FROM public.catalog_entries
        WHERE catalog_id = 'storage_document_types' AND slug = f.document_type), false) THEN
    RAISE EXCEPTION 'store: a draft of this document type is never shown to clients — save the signed copy or mark it filed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF f.published = p_published THEN RETURN false; END IF;
  UPDATE public.store_files SET published = p_published WHERE id = p_file_id;
  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot)
  VALUES (CASE WHEN p_published THEN 'published' ELSE 'unpublished' END, p_actor, f.owner_id, f.id, f.folder_id, f.name);
  RETURN true;
END $function$;
COMMIT;
