-- UNDO of 20261025-1200-storage-safe-save.sql.
--
-- PRE-CHECKS (run these first; the guard below RAISES if either is above zero):
--   SELECT count(*) FROM public.store_file_versions WHERE unmerged;           -- hidden "not applied" versions: they lose their hidden flag
--                                                                             -- AND keep a version number HIGHER than the file's current one, so the
--                                                                             -- ORIGINAL store_write (cur.version_no + 1) would collide with
--                                                                             -- UNIQUE (file_id, version_no) on the next save of such a file.
--   SELECT count(*) FROM public.store_files WHERE marked_signed_at IS NOT NULL; -- people's "this is a signed document" marks: the column is dropped
--                                                                             -- and those files become editable in place again.
-- If both are zero the UNDO is lossless. If not, decide first (export the rows, or merge/discard the unmerged versions), then, knowing
-- what is lost, run in the SAME transaction before this script:   SET LOCAL store.allow_unsafe_undo = 'on';
BEGIN;
DO $$
DECLARE
  v_unmerged int;
  v_signed int;
BEGIN
  SELECT count(*) INTO v_unmerged FROM public.store_file_versions WHERE unmerged;
  SELECT count(*) INTO v_signed FROM public.store_files WHERE marked_signed_at IS NOT NULL;
  IF (v_unmerged > 0 OR v_signed > 0) AND coalesce(current_setting('store.allow_unsafe_undo', true), '') <> 'on' THEN
    RAISE EXCEPTION 'UNDO refused: % unmerged version(s) and % file(s) marked signed would be damaged (see the header of this file). Set store.allow_unsafe_undo = on only after deciding.', v_unmerged, v_signed;
  END IF;
END $$;
DROP TRIGGER IF EXISTS trg_store_files_version_lock ON public.store_files;
DROP FUNCTION IF EXISTS public.store_files_version_lock();
DROP FUNCTION IF EXISTS public.store_append_version(jsonb);
DROP FUNCTION IF EXISTS public.store_files_edit_info(uuid[]);
DROP FUNCTION IF EXISTS public.store_lock_class(uuid);
DELETE FROM public.app_settings WHERE key = 'store_signed_key_prefixes';
UPDATE public.catalog_entries SET metadata = metadata - 'replace_only'
 WHERE catalog_id = 'storage_document_types' AND slug IN ('passport', 'id_document');
ALTER TABLE public.store_file_versions DROP COLUMN IF EXISTS unmerged;
ALTER TABLE public.store_files DROP COLUMN IF EXISTS marked_signed_at;
-- store_write back to the original text of 20260925-1100
CREATE OR REPLACE FUNCTION public.store_write(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_owner   uuid := (p->>'owner_id')::uuid;
  v_folder  uuid := (p->>'folder_id')::uuid;
  v_key     text := nullif(btrim(coalesce(p->>'caller_key', '')), '');
  v_name    text := btrim(coalesce(p->>'name', ''));
  v_sha     text := p->>'sha256';
  v_fs      text := nullif(p->>'filing_status', '');
  v_changed boolean := coalesce((p->>'content_changed')::boolean, true);
  v_actor   uuid := nullif(p->>'actor', '')::uuid;
  v_file    record;
  v_cur     record;
  v_file_id uuid;
  v_ver_id  uuid;
  v_status  text;
  v_try     text;
  v_base    text;
  v_ext     text;
  v_n       int := 1;
  v_rank_old int;
  v_rank_new int;
  v_found   boolean := false;
  v_type    record;
  v_pub     boolean;
  v_sup     uuid := nullif(p->>'supersedes_file_id','')::uuid;
  v_link_owner uuid;
  l jsonb;
BEGIN
  IF v_owner IS NULL OR v_folder IS NULL OR v_name = '' OR v_sha IS NULL THEN
    RAISE EXCEPTION 'store: owner, folder, name and sha256 are required';
  END IF;
  IF v_fs IS NOT NULL AND v_fs NOT IN ('none','draft','filed','amended') THEN
    RAISE EXCEPTION 'store: unknown filing status %', v_fs;
  END IF;
  IF v_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('store_key:' || v_key, 0));
    SELECT id, owner_id, folder_id, state, filing_status, current_version_id, name INTO v_file
      FROM public.store_files WHERE caller_key = v_key AND state <> 'purged';
    v_found := FOUND;
  END IF;

  IF v_found THEN
    v_file_id := v_file.id;
    PERFORM public.store_lock_owner(v_file.owner_id);
    IF v_file.state = 'trashed' THEN
      RETURN jsonb_build_object('status','trashed','file_id',v_file.id,'version_id',v_file.current_version_id,'name',v_file.name);
    END IF;
    SELECT id, sha256, version_no INTO v_cur FROM public.store_file_versions WHERE id = v_file.current_version_id;
    v_rank_old := CASE v_file.filing_status WHEN 'none' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END;
    v_rank_new := CASE coalesce(v_fs, v_file.filing_status) WHEN 'none' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END;

    IF v_cur.sha256 = v_sha OR (NOT v_changed AND v_cur.id IS NOT NULL) THEN
      -- same content (or a re-render with no meaningful change): only a FORWARD filing-status move is recorded
      IF v_fs IN ('draft','filed') AND v_rank_new > v_rank_old THEN
        UPDATE public.store_files SET filing_status = v_fs WHERE id = v_file.id;
        INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, details)
        VALUES (CASE WHEN v_fs = 'filed' THEN 'filed' ELSE 'status_changed' END, v_actor, v_file.owner_id, v_file.id, v_file.folder_id, v_file.name,
                jsonb_build_object('from', v_file.filing_status, 'to', v_fs));
      END IF;
      v_status := 'unchanged';
      v_ver_id := v_cur.id;
    ELSIF v_file.filing_status = 'filed' THEN
      RETURN jsonb_build_object('status','frozen','file_id',v_file.id,'version_id',v_cur.id,'name',v_file.name);
    ELSE
      INSERT INTO public.store_file_versions (file_id, version_no, storage_bucket, storage_path, sha256, size_bytes, mime_type, created_by)
      VALUES (v_file.id, coalesce(v_cur.version_no, 0) + 1, p->>'bucket', p->>'path', v_sha, (p->>'size')::bigint, p->>'mime', v_actor)
      RETURNING id INTO v_ver_id;
      -- document type and year are set at creation only (a staff correction is never overwritten);
      -- filing status only moves forward (none → draft → filed)
      UPDATE public.store_files
         SET current_version_id = v_ver_id,
             filing_status = CASE WHEN v_fs IN ('draft','filed') AND v_rank_new > v_rank_old THEN v_fs ELSE filing_status END
       WHERE id = v_file.id;
      INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, details)
      VALUES ('version_added', v_actor, v_file.owner_id, v_file.id, v_file.folder_id, v_file.name,
              jsonb_build_object('version_id', v_ver_id, 'sha256', v_sha, 'size', (p->>'size')::bigint));
      v_status := 'versioned';
    END IF;
  ELSE
    PERFORM public.store_lock_owner(v_owner);
    -- keep the name; auto-suffix " (2)", " (3)"… on a live-name clash; never exceed 255 chars
    v_ext  := coalesce(substring(v_name from '(\.[A-Za-z0-9]{1,10})$'), '');
    v_base := left(v_name, length(v_name) - length(v_ext));
    v_try  := v_name;
    WHILE EXISTS (SELECT 1 FROM public.store_files WHERE folder_id = v_folder AND name_key = public.store_name_key(v_try)) LOOP
      v_n := v_n + 1;
      v_try := left(v_base, 255 - length(v_ext) - length(' (' || v_n || ')')) || ' (' || v_n || ')' || v_ext;
      IF v_n > 500 THEN RAISE EXCEPTION 'store: too many files named % in this folder', v_name; END IF;
    END LOOP;

    -- type defaults apply to NEW files only (plan 8.4): published default; a "draft never visible"
    -- type (the prepared return) starts as a draft unless the caller states a status
    SELECT coalesce((metadata->>'default_published')::boolean, false) AS def_pub,
           coalesce((metadata->>'draft_never_visible')::boolean, false) AS dnv
      INTO v_type FROM public.catalog_entries
     WHERE catalog_id = 'storage_document_types' AND slug = nullif(p->>'document_type','');
    -- a flow that states neither a status nor a visibility for a "draft never visible" type (the prepared
    -- return) gets a draft; a migration that passes the real status / published flag keeps them
    IF v_fs IS NULL AND p->'published' IS NULL AND coalesce(v_type.dnv, false) THEN v_fs := 'draft'; END IF;
    v_pub := coalesce((p->>'published')::boolean,
                      CASE WHEN coalesce(v_type.dnv, false) AND coalesce(v_fs,'none') = 'draft' THEN false END,
                      nullif(coalesce(v_type.def_pub, false), false),
                      -- created in a client-safe stage of its real service case → shown (today's rule, fixed at creation)
                      EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p->'links','[]'::jsonb)) AS lk(v)
                                JOIN public.service_deliveries sd ON sd.id = (lk.v->>'record_id')::uuid
                                JOIN public.catalog_entries cs ON cs.catalog_id = 'storage_client_safe_stages' AND cs.status = 'active'
                                 AND cs.metadata->>'service_type' = sd.service_type
                               WHERE lk.v->>'kind' = 'service_case' AND cs.metadata->'stages' ? sd.stage),
                      false);
    IF v_sup IS NOT NULL THEN
      SELECT id, document_type, period_year INTO v_cur FROM public.store_files
       WHERE id = v_sup AND owner_id = v_owner AND state = 'live';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'store: the file being superseded must be a live file of the same owner';
      END IF;
      IF (v_cur.document_type IS NOT NULL AND nullif(p->>'document_type','') IS NOT NULL AND v_cur.document_type <> p->>'document_type')
         OR (v_cur.period_year IS NOT NULL AND (p->>'period_year') IS NOT NULL AND v_cur.period_year <> (p->>'period_year')::int) THEN
        RAISE EXCEPTION 'store: an amendment must have the same document type and year as the file it replaces';
      END IF;
      IF EXISTS (SELECT 1 FROM public.store_files n WHERE n.supersedes_file_id = v_sup AND n.state = 'live') THEN
        RAISE EXCEPTION 'store: that file has already been amended — amend the latest amendment instead';
      END IF;
      v_cur := NULL;
    END IF;
    INSERT INTO public.store_files (owner_id, folder_id, name, document_type, period_year, filing_status, caller_key, created_by, published, supersedes_file_id)
    VALUES (v_owner, v_folder, v_try, nullif(p->>'document_type',''), (p->>'period_year')::int, 'none', v_key, v_actor, v_pub, v_sup)
    RETURNING id INTO v_file_id;
    INSERT INTO public.store_file_versions (file_id, version_no, storage_bucket, storage_path, sha256, size_bytes, mime_type, created_by)
    VALUES (v_file_id, 1, p->>'bucket', p->>'path', v_sha, (p->>'size')::bigint, p->>'mime', v_actor)
    RETURNING id INTO v_ver_id;
    UPDATE public.store_files SET current_version_id = v_ver_id, filing_status = coalesce(v_fs, 'none') WHERE id = v_file_id;
    INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, details)
    VALUES ('created', v_actor, v_owner, v_file_id, v_folder, v_try,
            jsonb_build_object('version_id', v_ver_id, 'sha256', v_sha, 'size', (p->>'size')::bigint, 'caller_key', v_key,
                               'published', v_pub, 'supersedes_file_id', v_sup));
    IF v_sup IS NOT NULL THEN
      INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, details)
      VALUES ('superseded', v_actor, v_owner, v_sup, NULL, NULL, jsonb_build_object('by_file_id', v_file_id));
    END IF;
    v_status := 'created';
  END IF;

  -- links / subjects / facts: idempotent, same transaction, on created / versioned / unchanged
  SELECT owner_id INTO v_link_owner FROM public.store_files WHERE id = v_file_id;
  FOR l IN SELECT * FROM jsonb_array_elements(coalesce(p->'links', '[]'::jsonb)) LOOP
    IF NOT public.store_link_belongs(v_link_owner, l->>'kind', (l->>'record_id')::uuid) THEN
      RAISE EXCEPTION 'store: % link % does not belong to this file''s owner', l->>'kind', l->>'record_id' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.store_record_links (file_id, link_kind, record_id, stage_at_creation, tax_year)
    VALUES (v_file_id, l->>'kind', (l->>'record_id')::uuid,
            CASE WHEN l->>'kind' = 'service_case' THEN (SELECT stage FROM public.service_deliveries WHERE id = (l->>'record_id')::uuid) END,
            (l->>'tax_year')::int)
    ON CONFLICT DO NOTHING;
  END LOOP;
  FOR l IN SELECT * FROM jsonb_array_elements(coalesce(p->'subjects', '[]'::jsonb)) LOOP
    INSERT INTO public.store_file_subjects (file_id, subject_kind, contact_id, account_id, role)
    VALUES (v_file_id, l->>'kind', (l->>'contact_id')::uuid, (l->>'account_id')::uuid, l->>'role')
    ON CONFLICT DO NOTHING;
  END LOOP;
  FOR l IN SELECT * FROM jsonb_array_elements(coalesce(p->'facts', '[]'::jsonb)) LOOP
    INSERT INTO public.store_file_facts (file_id, key, value, source, version_id)
    SELECT v_file_id, l->>'key', l->>'value', coalesce(l->>'source','rule'), v_ver_id
     WHERE NOT EXISTS (SELECT 1 FROM public.store_file_facts f
                        WHERE f.file_id = v_file_id AND f.key = l->>'key' AND f.value = l->>'value'
                          AND f.version_id IS NOT DISTINCT FROM v_ver_id);
  END LOOP;

  SELECT name INTO v_try FROM public.store_files WHERE id = v_file_id;
  RETURN jsonb_build_object('status', v_status, 'file_id', v_file_id, 'version_id', v_ver_id, 'name', v_try);
END $$;
REVOKE ALL ON FUNCTION public.store_write(jsonb) FROM PUBLIC, anon, authenticated;

COMMIT;
