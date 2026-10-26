-- Storage data-layer hardening (storage deep bug hunt, "fix everything" — branch claude/fix-storage-datalayer) — 2026-10-25
-- Additive / CREATE OR REPLACE only; UNDO beside it restores the previous function text. Sandbox first (R105). Idempotent.
--
--  1. LOCK ORDER (deadlocks): store_files_guard / store_folders_guard take the OWNER advisory lock in a BEFORE trigger, i.e. AFTER
--     any `SELECT … FOR UPDATE` row lock a function already holds. store_write and the append function take the owner lock FIRST.
--     Functions that took the row first (store_attach_formation, store_set_published, store_set_filing_status, store_remove_link,
--     store_rename_root) could therefore deadlock against a concurrent save ("deadlock detected"). They now take
--     store_lock_owner FIRST, then the row lock (same bodies otherwise).
--  2. REHOME KEEPS NO STALE STATE: store_rehome_file / store_rehome_subtree now drop the record links and subjects that no longer
--     belong to the new owner (store_link_belongs / new store_subject_belongs) in the SAME transaction, writing one
--     'rehome_dropped' history row with the dropped rows; moving the file BACK restores them (so "undo move" is lossless).
--  3. store_abandoned_intents no longer treats an upload slot as abandoned while a register job for it is still pending/processing
--     (the cleanup would delete the staged bytes before the background job claimed them).
--  4. store_purge_pending_objects drives from the (small) set of leftover bucket objects instead of ordering every purged version.
--  5. store_files.current_version_id must be a version OF THAT FILE (composite FK, deferrable, NOT VALID then validated if clean).
--  6. "2. Contacts" is a VIEW: a file or sub-folder can no longer be put inside a 'contacts' folder (until now only the app refused).
BEGIN;

-- ───────────────────────────────────────────────────────────────  1. lock order
CREATE OR REPLACE FUNCTION public.store_attach_formation(p_service_delivery_id uuid, p_account_id uuid, p_actor uuid DEFAULT NULL, p_company_name text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_oid uuid;
  v_owner record;
  v_existing uuid;
BEGIN
  IF p_service_delivery_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'store: attach needs both the formation service case and the company (no guessing)';
  END IF;
  SELECT id INTO v_oid FROM public.store_owners WHERE service_delivery_id = p_service_delivery_id LIMIT 1;
  IF v_oid IS NULL THEN
    RETURN NULL;
  END IF;
  -- the owner lock FIRST (store_write's order), then the row lock
  PERFORM public.store_lock_owner(v_oid);
  SELECT * INTO v_owner FROM public.store_owners WHERE id = v_oid FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.store_rename_root(p_owner_id uuid, p_name text, p_actor uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_root record;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN RETURN false; END IF;
  PERFORM public.store_lock_owner(p_owner_id);   -- owner lock before the folder row lock (the folder trigger takes it anyway)
  SELECT id, name INTO v_root FROM public.store_folders
   WHERE owner_id = p_owner_id AND parent_id IS NULL AND trashed_at IS NULL FOR UPDATE;
  IF v_root.id IS NULL OR v_root.name = btrim(p_name) THEN RETURN false; END IF;
  UPDATE public.store_folders SET name = btrim(p_name), updated_at = now() WHERE id = v_root.id;
  INSERT INTO public.store_events (event, actor, owner_id, folder_id, name_snapshot, details)
  VALUES ('folder_renamed', p_actor, p_owner_id, v_root.id, btrim(p_name), jsonb_build_object('from', v_root.name));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.store_set_published(p_file_id uuid, p_published boolean, p_actor uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  f record;
  v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.store_files WHERE id = p_file_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'store: only a live file can be published or unpublished'; END IF;
  PERFORM public.store_lock_owner(v_owner);   -- owner lock FIRST (the files trigger takes it after a row lock otherwise)
  SELECT id, owner_id, folder_id, name, state, published, filing_status, document_type, needs_review_at INTO f
    FROM public.store_files WHERE id = p_file_id FOR UPDATE;
  IF f.owner_id IS DISTINCT FROM v_owner THEN   -- re-homed while we waited: take the new owner's lock too
    PERFORM public.store_lock_owner(f.owner_id);
  END IF;
  IF f.id IS NULL OR f.state <> 'live' THEN RAISE EXCEPTION 'store: only a live file can be published or unpublished'; END IF;
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

CREATE OR REPLACE FUNCTION public.store_set_filing_status(p_file_id uuid, p_status text, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_old int;
  v_new int;
  v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.store_files WHERE id = p_file_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'store: only a live file can change filing status'; END IF;
  PERFORM public.store_lock_owner(v_owner);   -- owner lock FIRST
  SELECT id, owner_id, folder_id, name, state, filing_status, supersedes_file_id INTO f
    FROM public.store_files WHERE id = p_file_id FOR UPDATE;
  IF f.owner_id IS DISTINCT FROM v_owner THEN PERFORM public.store_lock_owner(f.owner_id); END IF;
  IF f.id IS NULL OR f.state <> 'live' THEN RAISE EXCEPTION 'store: only a live file can change filing status'; END IF;
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

-- store_remove_link is NOT defined here any more: its current definition (hold freeze + owner-lock first) lives in
-- 20261025-1800-storage-hold-sticks.sql. Re-running this file whole must never put an older copy back.


-- ───────────────────────────────────────────────────────────────  2. rehome keeps no stale links / subjects
-- Does a subject (a person or a company a file is "about") still belong with this owner? Generous on purpose (any membership row,
-- ended or not): this decides what is DROPPED, so doubt keeps the row.
CREATE OR REPLACE FUNCTION public.store_subject_belongs(p_owner_id uuid, p_kind text, p_contact_id uuid, p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  o record;
  sd record;
BEGIN
  SELECT * INTO o FROM public.store_owners WHERE id = p_owner_id;
  IF NOT FOUND OR o.kind IN ('unfiled', 'private', 'business') THEN RETURN false; END IF;
  IF o.kind = 'formation' THEN
    SELECT contact_id, account_id INTO sd FROM public.service_deliveries WHERE id = o.service_delivery_id;
  END IF;
  IF p_kind = 'person' THEN
    IF o.kind = 'person' THEN RETURN o.contact_id = p_contact_id; END IF;
    IF o.kind = 'company' THEN
      RETURN EXISTS (SELECT 1 FROM public.account_contacts ac WHERE ac.account_id = o.account_id AND ac.contact_id = p_contact_id);
    END IF;
    IF o.kind = 'formation' THEN
      RETURN sd.contact_id = p_contact_id
          OR (sd.account_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.account_contacts ac WHERE ac.account_id = sd.account_id AND ac.contact_id = p_contact_id));
    END IF;
  ELSIF p_kind = 'company' THEN
    IF o.kind = 'company' THEN RETURN o.account_id = p_account_id; END IF;
    IF o.kind = 'formation' THEN RETURN sd.account_id = p_account_id; END IF;
    IF o.kind = 'person' THEN
      RETURN EXISTS (SELECT 1 FROM public.account_contacts ac WHERE ac.account_id = p_account_id AND ac.contact_id = o.contact_id);
    END IF;
  END IF;
  RETURN false;
END $$;

-- After a file changed owner: restore what was dropped when it LEFT this owner earlier (move undone), then drop what does not belong.
CREATE OR REPLACE FUNCTION public.store_rehome_reconcile(p_file_ids uuid[], p_from_owner uuid, p_to_owner uuid, p_actor uuid)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_file uuid;
  v_ev record;
  r jsonb;
  v_links jsonb;
  v_subjects jsonb;
  v_dropped int := 0;
  v_file_row record;
BEGIN
  FOREACH v_file IN ARRAY coalesce(p_file_ids, ARRAY[]::uuid[]) LOOP
    SELECT id, folder_id, name INTO v_file_row FROM public.store_files WHERE id = v_file;
    IF NOT FOUND THEN CONTINUE; END IF;

    -- (a) coming BACK to an owner the file once left: put back what was dropped then (only what belongs)
    SELECT details INTO v_ev FROM public.store_events
     WHERE file_id = v_file AND event = 'rehome_dropped' AND details->>'from_owner' = p_to_owner::text
     ORDER BY id DESC LIMIT 1;
    IF FOUND THEN
      FOR r IN SELECT * FROM jsonb_array_elements(coalesce(v_ev.details->'links', '[]'::jsonb)) LOOP
        IF public.store_link_belongs(p_to_owner, r->>'link_kind', (r->>'record_id')::uuid) THEN
          INSERT INTO public.store_record_links (file_id, link_kind, record_id, stage_at_creation, tax_year, created_at)
          VALUES (v_file, r->>'link_kind', (r->>'record_id')::uuid, r->>'stage_at_creation', (r->>'tax_year')::int,
                  coalesce((r->>'created_at')::timestamptz, now()))
          ON CONFLICT DO NOTHING;
        END IF;
      END LOOP;
      FOR r IN SELECT * FROM jsonb_array_elements(coalesce(v_ev.details->'subjects', '[]'::jsonb)) LOOP
        IF public.store_subject_belongs(p_to_owner, r->>'subject_kind', (r->>'contact_id')::uuid, (r->>'account_id')::uuid) THEN
          INSERT INTO public.store_file_subjects (file_id, subject_kind, contact_id, account_id, role, created_at)
          VALUES (v_file, r->>'subject_kind', (r->>'contact_id')::uuid, (r->>'account_id')::uuid, r->>'role',
                  coalesce((r->>'created_at')::timestamptz, now()))
          ON CONFLICT DO NOTHING;
        END IF;
      END LOOP;
    END IF;

    -- (b) drop what no longer belongs to the new owner (remember it in the history row)
    WITH gone AS (
      DELETE FROM public.store_record_links l
       WHERE l.file_id = v_file AND NOT public.store_link_belongs(p_to_owner, l.link_kind, l.record_id)
      RETURNING l.link_kind, l.record_id, l.stage_at_creation, l.tax_year, l.created_at)
    SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]'::jsonb) INTO v_links FROM gone;
    WITH gone AS (
      DELETE FROM public.store_file_subjects s
       WHERE s.file_id = v_file AND NOT public.store_subject_belongs(p_to_owner, s.subject_kind, s.contact_id, s.account_id)
      RETURNING s.subject_kind, s.contact_id, s.account_id, s.role, s.created_at)
    SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]'::jsonb) INTO v_subjects FROM gone;
    IF jsonb_array_length(v_links) + jsonb_array_length(v_subjects) > 0 THEN
      v_dropped := v_dropped + jsonb_array_length(v_links) + jsonb_array_length(v_subjects);
      INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, reason, details)
      VALUES ('rehome_dropped', p_actor, p_to_owner, v_file, v_file_row.folder_id, v_file_row.name,
              'Links and people that do not belong to the new owner were removed',
              jsonb_build_object('from_owner', p_from_owner, 'to_owner', p_to_owner, 'links', v_links, 'subjects', v_subjects));
    END IF;
  END LOOP;
  RETURN v_dropped;
END $$;

CREATE OR REPLACE FUNCTION public.store_rehome_subtree(p_folder_id uuid, p_to_owner uuid, p_to_parent uuid, p_actor uuid, p_reason text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_from_owner uuid;
  v_count integer;
  v_ids uuid[];
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

  WITH moved AS (
    UPDATE public.store_files SET owner_id = p_to_owner
     WHERE folder_id IN (WITH RECURSIVE sub(id) AS (
        SELECT p_folder_id UNION ALL SELECT f.id FROM public.store_folders f JOIN sub ON f.parent_id = sub.id)
      SELECT id FROM sub)
    RETURNING id)
  SELECT array_agg(id) INTO v_ids FROM moved;
  PERFORM set_config('store.privileged', 'off', true);

  -- links / people that belong to the OLD owner only are dropped (and kept in the history), the same transaction
  PERFORM public.store_rehome_reconcile(v_ids, v_from_owner, p_to_owner, p_actor);

  INSERT INTO public.store_events (event, actor, owner_id, folder_id, reason, details)
  VALUES ('rehomed', p_actor, p_to_owner, p_folder_id, p_reason, jsonb_build_object('from_owner', v_from_owner, 'folders', v_count));
  RETURN v_count;
END $$;

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

  -- links / people that belong to the OLD owner only are dropped (and kept in the history), the same transaction
  PERFORM public.store_rehome_reconcile(ARRAY[p_file_id], v_file.owner_id, v_to_owner, p_actor);

  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, reason, details)
  VALUES ('rehomed', p_actor, v_to_owner, p_file_id, p_to_folder, v_file.name, p_reason, jsonb_build_object('from_owner', v_file.owner_id));
END $$;

-- ───────────────────────────────────────────────────────────────  3. queued uploads are not abandoned
CREATE INDEX IF NOT EXISTS job_queue_register_upload_idx
  ON public.job_queue (related_entity_id) WHERE job_type = 'crm_store_register_upload' AND status IN ('pending', 'processing');

CREATE OR REPLACE FUNCTION public.store_abandoned_intents(p_limit integer DEFAULT 200)
RETURNS TABLE (id uuid, staging_path text, dest_path text) LANGUAGE sql STABLE AS $$
  SELECT i.id, i.staging_path, i.dest_path FROM public.store_upload_intents i
   WHERE i.consumed_at IS NULL
     AND ((i.claimed_at IS NULL AND i.expires_at < now() - interval '1 hour')
       OR (i.claimed_at IS NOT NULL AND i.lease_until < now() - interval '1 hour'))
     -- a large upload waits in the queue for its register job: the staged bytes are still needed (a job stuck for a week is given up on)
     AND NOT EXISTS (SELECT 1 FROM public.job_queue j
                      WHERE j.job_type = 'crm_store_register_upload' AND j.related_entity_id = i.id
                        AND j.status IN ('pending', 'processing') AND j.created_at > now() - interval '7 days')
   ORDER BY i.created_at LIMIT p_limit
$$;

-- ───────────────────────────────────────────────────────────────  4. bounded purge sweep
CREATE INDEX IF NOT EXISTS store_files_purged_idx ON public.store_files (purged_at) WHERE state = 'purged';

CREATE OR REPLACE FUNCTION public.store_purge_pending_objects(p_limit integer DEFAULT 200)
RETURNS TABLE (bucket text, path text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, storage AS $$
  -- drive from the bucket objects that still exist (a small set once removals work) — not from every purged version ever
  SELECT v.storage_bucket, v.storage_path
    FROM storage.objects o
    JOIN public.store_file_versions v ON v.storage_bucket = o.bucket_id AND v.storage_path = o.name
    JOIN public.store_files f ON f.id = v.file_id
   WHERE o.bucket_id = 'crm-store' AND f.state = 'purged'
   ORDER BY f.purged_at, v.storage_path
   LIMIT p_limit
$$;

-- ───────────────────────────────────────────────────────────────  5. current version must belong to the file
CREATE UNIQUE INDEX IF NOT EXISTS store_file_versions_id_file_uq ON public.store_file_versions (id, file_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_files_current_version_same_file_fk' AND conrelid = 'public.store_files'::regclass) THEN
    ALTER TABLE public.store_files
      ADD CONSTRAINT store_files_current_version_same_file_fk
      FOREIGN KEY (current_version_id, id) REFERENCES public.store_file_versions (id, file_id)
      DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
  -- existing rows are checked now; if some old row is wrong the constraint stays enforced for every NEW/changed row and is reported
  BEGIN
    ALTER TABLE public.store_files VALIDATE CONSTRAINT store_files_current_version_same_file_fk;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE WARNING 'store: some existing files point at a version of ANOTHER file — constraint enforced for new rows only; list them with: SELECT f.id FROM store_files f LEFT JOIN store_file_versions v ON v.id = f.current_version_id WHERE f.current_version_id IS NOT NULL AND v.file_id IS DISTINCT FROM f.id';
  END;
END $$;

-- ───────────────────────────────────────────────────────────────  6. "2. Contacts" is a view: no files, no folders inside it
CREATE OR REPLACE FUNCTION public.store_contacts_view_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
BEGIN
  IF TG_TABLE_NAME = 'store_files' THEN
    IF NEW.state = 'live' THEN
      SELECT kind INTO v_kind FROM public.store_folders WHERE id = NEW.folder_id;
      IF v_kind = 'contacts' THEN
        RAISE EXCEPTION 'store: "2. Contacts" only shows the people''s own storages — it holds no files' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW.parent_id IS NOT NULL THEN
    SELECT kind INTO v_kind FROM public.store_folders WHERE id = NEW.parent_id;
    IF v_kind = 'contacts' THEN
      RAISE EXCEPTION 'store: "2. Contacts" only shows the people''s own storages — it holds no folders' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_store_files_contacts_view ON public.store_files;
CREATE TRIGGER trg_store_files_contacts_view
  BEFORE INSERT OR UPDATE OF folder_id ON public.store_files
  FOR EACH ROW EXECUTE FUNCTION public.store_contacts_view_guard();
DROP TRIGGER IF EXISTS trg_store_folders_contacts_view ON public.store_folders;
CREATE TRIGGER trg_store_folders_contacts_view
  BEFORE INSERT OR UPDATE OF parent_id ON public.store_folders
  FOR EACH ROW EXECUTE FUNCTION public.store_contacts_view_guard();

REVOKE ALL ON FUNCTION public.store_subject_belongs(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_rehome_reconcile(uuid[], uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_contacts_view_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_attach_formation(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_rename_root(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_set_published(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_set_filing_status(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
-- (store_remove_link REVOKE: see 20261025-1800-storage-hold-sticks.sql)
REVOKE ALL ON FUNCTION public.store_rehome_file(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_rehome_subtree(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_abandoned_intents(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_purge_pending_objects(integer) FROM PUBLIC, anon, authenticated;

COMMIT;
