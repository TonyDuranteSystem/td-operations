-- UNDO of 20261025-1500-storage-datalayer-hardening.sql — restores the previous text of every replaced function and drops what the
-- migration added. Nothing in the data is lost: rows the rehome cleanup dropped are kept in store_events ('rehome_dropped' details).
-- Run order: this file alone, in one transaction.
BEGIN;
DROP TRIGGER IF EXISTS trg_store_files_contacts_view ON public.store_files;
DROP TRIGGER IF EXISTS trg_store_folders_contacts_view ON public.store_folders;
DROP FUNCTION IF EXISTS public.store_contacts_view_guard();
ALTER TABLE public.store_files DROP CONSTRAINT IF EXISTS store_files_current_version_same_file_fk;
DROP INDEX IF EXISTS public.store_file_versions_id_file_uq;
DROP INDEX IF EXISTS public.store_files_purged_idx;
DROP INDEX IF EXISTS public.job_queue_register_upload_idx;

-- store_attach_formation (back to 20260926-1900-crm-store-s6-formation-pilot.sql)
CREATE OR REPLACE FUNCTION public.store_attach_formation(p_service_delivery_id uuid, p_account_id uuid, p_actor uuid DEFAULT NULL, p_company_name text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_owner record;
  v_existing uuid;
BEGIN
  IF p_service_delivery_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'store: attach needs both the formation service case and the company (no guessing)';
  END IF;
  SELECT * INTO v_owner FROM public.store_owners WHERE service_delivery_id = p_service_delivery_id FOR UPDATE;
  IF v_owner.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_owner.kind = 'company' THEN
    IF v_owner.account_id = p_account_id THEN RETURN v_owner.id; END IF;
    RAISE EXCEPTION 'store: formation % is already attached to another company', p_service_delivery_id;
  END IF;
  IF v_owner.lifecycle_override = 'archived' THEN
    RAISE EXCEPTION 'store: formation % was cancelled — reactivate it before attaching', p_service_delivery_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_deliveries WHERE id = p_service_delivery_id AND account_id = p_account_id) THEN
    RAISE EXCEPTION 'store: formation % is not linked to company % — attach only after the company-creation step linked it', p_service_delivery_id, p_account_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO v_existing FROM public.store_owners WHERE account_id = p_account_id;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'store: company % already has its own storage — needs a staff merge, not an automatic attach', p_account_id;
  END IF;

  PERFORM public.store_lock_owner(v_owner.id);
  UPDATE public.store_owners
     SET kind = 'company', account_id = p_account_id, lifecycle_override = NULL, updated_at = now()
   WHERE id = v_owner.id;
  IF p_company_name IS NOT NULL AND btrim(p_company_name) <> '' THEN
    UPDATE public.store_folders SET name = p_company_name WHERE owner_id = v_owner.id AND parent_id IS NULL;
  END IF;

  INSERT INTO public.store_events (event, actor, owner_id, reason, details)
  VALUES ('formation_attached', p_actor, v_owner.id, 'Articles received — company created',
          jsonb_build_object('service_delivery_id', p_service_delivery_id, 'account_id', p_account_id));
  RETURN v_owner.id;
END $$;

-- store_rename_root (back to 20260926-1900-crm-store-s6-formation-pilot.sql)
CREATE OR REPLACE FUNCTION public.store_rename_root(p_owner_id uuid, p_name text, p_actor uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_root record;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN RETURN false; END IF;
  SELECT id, name INTO v_root FROM public.store_folders
   WHERE owner_id = p_owner_id AND parent_id IS NULL AND trashed_at IS NULL FOR UPDATE;
  IF v_root.id IS NULL OR v_root.name = btrim(p_name) THEN RETURN false; END IF;
  UPDATE public.store_folders SET name = btrim(p_name), updated_at = now() WHERE id = v_root.id;
  INSERT INTO public.store_events (event, actor, owner_id, folder_id, name_snapshot, details)
  VALUES ('folder_renamed', p_actor, p_owner_id, v_root.id, btrim(p_name), jsonb_build_object('from', v_root.name));
  RETURN true;
END $$;

-- store_set_published (back to 20260928-1300-crm-store-needs-review-guard.sql)
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

-- store_set_filing_status (back to 20260925-1500-crm-store-s3-access.sql)
CREATE OR REPLACE FUNCTION public.store_set_filing_status(p_file_id uuid, p_status text, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_old int;
  v_new int;
BEGIN
  SELECT id, owner_id, folder_id, name, state, filing_status, supersedes_file_id INTO f
    FROM public.store_files WHERE id = p_file_id FOR UPDATE;
  IF NOT FOUND OR f.state <> 'live' THEN RAISE EXCEPTION 'store: only a live file can change filing status'; END IF;
  IF p_status NOT IN ('draft','filed','amended') THEN RAISE EXCEPTION 'store: unknown filing status %', p_status; END IF;
  IF p_status = 'amended' AND f.supersedes_file_id IS NULL THEN
    RAISE EXCEPTION 'store: only a file that replaces another one can be marked amended';
  END IF;
  v_old := CASE f.filing_status WHEN 'none' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END;
  v_new := CASE p_status WHEN 'draft' THEN 1 ELSE 2 END;
  IF f.filing_status = p_status THEN RETURN false; END IF;
  IF v_new <= v_old THEN RAISE EXCEPTION 'store: filing status only moves forward (% → % refused)', f.filing_status, p_status; END IF;
  UPDATE public.store_files SET filing_status = p_status WHERE id = p_file_id;
  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, details)
  VALUES (CASE WHEN p_status = 'draft' THEN 'status_changed' ELSE p_status END, p_actor, f.owner_id, f.id, f.folder_id, f.name,
          jsonb_build_object('from', f.filing_status, 'to', p_status));
  RETURN true;
END $$;

-- store_remove_link (back to 20260925-2000-crm-store-s4-trash.sql)
CREATE OR REPLACE FUNCTION public.store_remove_link(p_file_id uuid, p_link_kind text, p_record_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  l record;
  f record;
BEGIN
  SELECT * INTO l FROM public.store_record_links WHERE file_id = p_file_id AND link_kind = p_link_kind AND record_id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT owner_id, folder_id, name INTO f FROM public.store_files WHERE id = p_file_id;
  DELETE FROM public.store_record_links WHERE file_id = p_file_id AND link_kind = p_link_kind AND record_id = p_record_id;
  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, reason, details)
  VALUES ('link_removed', p_actor, f.owner_id, p_file_id, f.folder_id, f.name, p_reason, to_jsonb(l) - 'file_id');
  RETURN true;
END $$;

-- store_rehome_subtree (back to 20260924-2300-crm-store-foundation-s1.sql)
CREATE OR REPLACE FUNCTION public.store_rehome_subtree(p_folder_id uuid, p_to_owner uuid, p_to_parent uuid, p_actor uuid, p_reason text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_from_owner uuid;
  v_count integer;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'store: a re-home needs a reason'; END IF;
  SELECT owner_id INTO v_from_owner FROM public.store_folders WHERE id = p_folder_id;
  IF v_from_owner IS NULL THEN RAISE EXCEPTION 'store: folder % not found', p_folder_id; END IF;
  IF p_to_owner = v_from_owner THEN RAISE EXCEPTION 'store: re-home is only for moving to another owner'; END IF;
  PERFORM public.store_lock_owner(least(v_from_owner, p_to_owner));
  PERFORM public.store_lock_owner(greatest(v_from_owner, p_to_owner));
  IF p_to_parent IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.store_folders WHERE id = p_to_parent AND owner_id = p_to_owner AND trashed_at IS NULL) THEN
    RAISE EXCEPTION 'store: target folder must be a live folder of the new owner';
  END IF;

  PERFORM set_config('store.privileged', 'on', true);
  WITH RECURSIVE sub(id) AS (
    SELECT p_folder_id
    UNION ALL
    SELECT f.id FROM public.store_folders f JOIN sub ON f.parent_id = sub.id
  )
  UPDATE public.store_folders f SET owner_id = p_to_owner,
         parent_id = CASE WHEN f.id = p_folder_id THEN p_to_parent ELSE f.parent_id END
   WHERE f.id IN (SELECT id FROM sub);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.store_files SET owner_id = p_to_owner
   WHERE folder_id IN (WITH RECURSIVE sub(id) AS (
      SELECT p_folder_id UNION ALL SELECT f.id FROM public.store_folders f JOIN sub ON f.parent_id = sub.id)
    SELECT id FROM sub);
  PERFORM set_config('store.privileged', 'off', true);

  INSERT INTO public.store_events (event, actor, owner_id, folder_id, reason, details)
  VALUES ('rehomed', p_actor, p_to_owner, p_folder_id, p_reason, jsonb_build_object('from_owner', v_from_owner, 'folders', v_count));
  RETURN v_count;
END $$;

-- store_rehome_file (back to 20260924-2300-crm-store-foundation-s1.sql)
CREATE OR REPLACE FUNCTION public.store_rehome_file(p_file_id uuid, p_to_folder uuid, p_actor uuid, p_reason text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_file record;
  v_to_owner uuid;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'store: a re-home needs a reason'; END IF;
  SELECT id, owner_id, name, state INTO v_file FROM public.store_files WHERE id = p_file_id;
  IF v_file.id IS NULL THEN RAISE EXCEPTION 'store: file % not found', p_file_id; END IF;
  IF v_file.state <> 'live' THEN RAISE EXCEPTION 'store: only a live file can be re-homed'; END IF;
  SELECT owner_id INTO v_to_owner FROM public.store_folders WHERE id = p_to_folder AND trashed_at IS NULL;
  IF v_to_owner IS NULL THEN RAISE EXCEPTION 'store: target folder must be live'; END IF;
  IF v_to_owner = v_file.owner_id THEN RAISE EXCEPTION 'store: same owner — use a normal move'; END IF;
  PERFORM public.store_lock_owner(least(v_file.owner_id, v_to_owner));
  PERFORM public.store_lock_owner(greatest(v_file.owner_id, v_to_owner));

  PERFORM set_config('store.privileged', 'on', true);
  UPDATE public.store_files SET owner_id = v_to_owner, folder_id = p_to_folder WHERE id = p_file_id;
  PERFORM set_config('store.privileged', 'off', true);

  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, reason, details)
  VALUES ('rehomed', p_actor, v_to_owner, p_file_id, p_to_folder, v_file.name, p_reason, jsonb_build_object('from_owner', v_file.owner_id));
END $$;

-- store_abandoned_intents (back to 20260925-1100-crm-store-s2-writer.sql)
CREATE OR REPLACE FUNCTION public.store_abandoned_intents(p_limit integer DEFAULT 200)
RETURNS TABLE (id uuid, staging_path text, dest_path text) LANGUAGE sql STABLE AS $$
  SELECT i.id, i.staging_path, i.dest_path FROM public.store_upload_intents i
   WHERE i.consumed_at IS NULL
     AND ((i.claimed_at IS NULL AND i.expires_at < now() - interval '1 hour')
       OR (i.claimed_at IS NOT NULL AND i.lease_until < now() - interval '1 hour'))
   ORDER BY i.created_at LIMIT p_limit
$$;

-- store_purge_pending_objects (back to 20260925-2000-crm-store-s4-trash.sql)
CREATE OR REPLACE FUNCTION public.store_purge_pending_objects(p_limit integer DEFAULT 200)
RETURNS TABLE (bucket text, path text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, storage AS $$
  SELECT v.storage_bucket, v.storage_path
    FROM public.store_file_versions v JOIN public.store_files f ON f.id = v.file_id
   WHERE f.state = 'purged'
     AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = v.storage_bucket AND o.name = v.storage_path)
   ORDER BY f.purged_at, v.storage_path
   LIMIT p_limit
$$;

DROP FUNCTION IF EXISTS public.store_rehome_reconcile(uuid[], uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.store_subject_belongs(uuid, text, uuid, uuid);
COMMIT;
