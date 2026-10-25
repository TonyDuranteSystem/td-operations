-- Storage: ONE safe save for every file (dev job bd21e833, master plan Part 54, step 1) — 2026-10-25
-- What this adds (all additive; UNDO beside it):
--  1. store_file_versions.unmerged — a save that lost a race is kept as a hidden "not applied" version, never overwritten.
--  2. app_settings 'store_signed_key_prefixes' — which filing keys mean "signed document" (data, editable without a deploy).
--  3. catalog flag `replace_only` on the document types passport + id_document (Antonio: passports and IDs are never edited in place;
--     he can add the flag to other types in the catalog).
--  4. store_lock_class(file) — ONE place that says why a file may not take a new version: filed / replaced / signed / replace_only / amended.
--  5. trigger store_files_version_lock — the rule is enforced for EVERY writer (store_write, the new function, importers, the Mac app):
--     replaced / signed / replace_only files refuse a new current version; an amended file needs the one-time confirmation flag that only
--     store_append_version sets; (filed stays frozen by store_files_guard, unchanged).
--  6. store_append_version(jsonb) — the safe "add a new version to an EXISTING file": base-version check (before the same-bytes test),
--     a retry of an already-applied save answers "unchanged", locks, 'unmerged' keep, audit event with source/device/ip/reason.
--  7. store_write re-patched: the file row is read AGAIN after the owner lock (race), and a new version number is max+1.
BEGIN;

ALTER TABLE public.store_file_versions ADD COLUMN IF NOT EXISTS unmerged boolean NOT NULL DEFAULT false;

INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('store_signed_key_prefixes', '["esign-signed:","offer-signed:","lease-signed:","oa-signed:","ss4-signed-company:"]'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

UPDATE public.catalog_entries
   SET metadata = metadata || '{"replace_only": true}'::jsonb
 WHERE catalog_id = 'storage_document_types' AND slug IN ('passport', 'id_document')
   AND coalesce(metadata->>'replace_only', '') <> 'true';

-- why may this file NOT take a new version? NULL = it may.
CREATE OR REPLACE FUNCTION public.store_lock_class(p_file_id uuid)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  f record;
  v_prefixes jsonb;
  v_pfx text;
  v_locked boolean;
BEGIN
  SELECT id, filing_status, caller_key, document_type INTO f FROM public.store_files WHERE id = p_file_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF f.filing_status = 'filed' THEN RETURN 'filed'; END IF;
  IF EXISTS (SELECT 1 FROM public.store_files n WHERE n.supersedes_file_id = f.id AND n.state = 'live') THEN RETURN 'replaced'; END IF;
  IF f.caller_key IS NOT NULL THEN
    SELECT value INTO v_prefixes FROM public.app_settings WHERE key = 'store_signed_key_prefixes';
    IF v_prefixes IS NOT NULL AND jsonb_typeof(v_prefixes) = 'array' THEN
      FOR v_pfx IN SELECT jsonb_array_elements_text(v_prefixes) LOOP
        IF v_pfx <> '' AND left(f.caller_key, length(v_pfx)) = v_pfx THEN RETURN 'signed'; END IF;
      END LOOP;
    END IF;
  END IF;
  IF f.document_type IS NOT NULL THEN
    SELECT coalesce((metadata->>'replace_only')::boolean, false) INTO v_locked
      FROM public.catalog_entries WHERE catalog_id = 'storage_document_types' AND slug = f.document_type AND status = 'active';
    IF coalesce(v_locked, false) THEN RETURN 'replace_only'; END IF;
  END IF;
  IF f.filing_status = 'amended' THEN RETURN 'amended'; END IF;
  RETURN NULL;
END $$;

-- the rule for EVERY writer: a locked file's current version cannot change
CREATE OR REPLACE FUNCTION public.store_files_version_lock()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c text;
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND OLD.current_version_id IS NOT NULL
     AND NOT public.store_is_privileged() THEN
    c := public.store_lock_class(OLD.id);
    IF c = 'signed' THEN
      RAISE EXCEPTION 'store: this is a signed document and cannot be changed in place — add a replacement file instead' USING ERRCODE = 'check_violation', DETAIL = 'lock:signed';
    ELSIF c = 'replace_only' THEN
      RAISE EXCEPTION 'store: a passport or ID is never edited in place — add a replacement file instead' USING ERRCODE = 'check_violation', DETAIL = 'lock:replace_only';
    ELSIF c = 'replaced' THEN
      RAISE EXCEPTION 'store: this file has been replaced by a newer file — change the newer file instead' USING ERRCODE = 'check_violation', DETAIL = 'lock:replaced';
    ELSIF c = 'amended' AND coalesce(current_setting('store.edit_confirmed', true), '') <> 'on' THEN
      RAISE EXCEPTION 'store: this is an amended return — a change must be confirmed with a reason' USING ERRCODE = 'check_violation', DETAIL = 'lock:amended';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_store_files_version_lock ON public.store_files;
CREATE TRIGGER trg_store_files_version_lock
  BEFORE UPDATE OF current_version_id ON public.store_files
  FOR EACH ROW EXECUTE FUNCTION public.store_files_version_lock();

-- add a NEW version to an EXISTING file (any file, whatever its caller key)
CREATE OR REPLACE FUNCTION public.store_append_version(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_file_id  uuid := nullif(p->>'file_id', '')::uuid;
  v_expected int  := nullif(p->>'expected_version_no', '')::int;
  v_sha      text := p->>'sha256';
  v_actor    uuid := nullif(p->>'actor', '')::uuid;
  v_source   text := coalesce(nullif(p->>'source', ''), 'web');
  v_confirmed boolean := coalesce((p->>'confirmed')::boolean, false);
  v_unmerged boolean := coalesce((p->>'unmerged')::boolean, false);
  v_owner    uuid;
  v_key      text;
  v_f        record;
  v_cur      record;
  v_lock     text;
  v_ver_id   uuid;
  v_no       int;
BEGIN
  IF v_file_id IS NULL OR v_sha IS NULL OR nullif(p->>'bucket', '') IS NULL OR nullif(p->>'path', '') IS NULL THEN
    RAISE EXCEPTION 'store: file, sha256, bucket and path are required';
  END IF;
  SELECT owner_id, caller_key INTO v_owner, v_key FROM public.store_files WHERE id = v_file_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  -- the same lock ORDER as store_write: key lock, then owner lock, then the file row, then READ AGAIN
  IF v_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('store_key:' || v_key, 0)); END IF;
  PERFORM public.store_lock_owner(v_owner);
  SELECT id, owner_id, folder_id, state, filing_status, current_version_id, name, published INTO v_f
    FROM public.store_files WHERE id = v_file_id FOR UPDATE;
  IF v_f.owner_id IS DISTINCT FROM v_owner THEN
    PERFORM public.store_lock_owner(v_f.owner_id);
    SELECT id, owner_id, folder_id, state, filing_status, current_version_id, name, published INTO v_f
      FROM public.store_files WHERE id = v_file_id FOR UPDATE;
  END IF;
  IF v_f.state = 'purged' THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_f.state = 'trashed' THEN RETURN jsonb_build_object('status', 'trashed', 'file_id', v_f.id, 'name', v_f.name); END IF;

  SELECT id, sha256, version_no, created_by, created_at INTO v_cur FROM public.store_file_versions WHERE id = v_f.current_version_id;

  -- 1. did the file change since the person opened it? (BEFORE the same-bytes test)
  IF v_expected IS NOT NULL AND coalesce(v_cur.version_no, 0) <> v_expected THEN
    -- a retry of a save that already went through (same bytes, same person, the very next number) is not a conflict
    IF v_cur.sha256 = v_sha AND v_cur.created_by IS NOT DISTINCT FROM v_actor AND v_cur.version_no = v_expected + 1 THEN
      RETURN jsonb_build_object('status', 'unchanged', 'already_applied', true, 'file_id', v_f.id, 'version_id', v_cur.id,
                                'version_no', v_cur.version_no, 'name', v_f.name);
    END IF;
    IF NOT v_unmerged THEN
      RETURN jsonb_build_object('status', 'conflict', 'file_id', v_f.id, 'name', v_f.name, 'current_version_id', v_cur.id,
                                'current_version_no', v_cur.version_no, 'current_by', v_cur.created_by, 'current_at', v_cur.created_at);
    END IF;
  END IF;

  -- 2. nothing new
  IF v_cur.sha256 = v_sha AND NOT v_unmerged THEN
    RETURN jsonb_build_object('status', 'unchanged', 'file_id', v_f.id, 'version_id', v_cur.id, 'version_no', v_cur.version_no, 'name', v_f.name);
  END IF;

  -- 3. locks (filed first, so a filed passport does not ask for a confirmation and then refuse)
  v_lock := public.store_lock_class(v_f.id);
  IF v_lock = 'filed' THEN RETURN jsonb_build_object('status', 'frozen', 'file_id', v_f.id, 'name', v_f.name); END IF;
  IF v_lock IN ('replaced', 'signed', 'replace_only') THEN
    RETURN jsonb_build_object('status', 'locked', 'kind', v_lock, 'file_id', v_f.id, 'name', v_f.name);
  END IF;
  IF v_lock = 'amended' AND NOT v_confirmed THEN
    RETURN jsonb_build_object('status', 'needs_confirmation', 'kind', 'amended', 'file_id', v_f.id, 'name', v_f.name,
                              'current_version_no', v_cur.version_no);
  END IF;

  -- 4. the new version
  SELECT coalesce(max(version_no), 0) + 1 INTO v_no FROM public.store_file_versions WHERE file_id = v_f.id;
  INSERT INTO public.store_file_versions (file_id, version_no, storage_bucket, storage_path, sha256, size_bytes, mime_type, created_by, unmerged)
  VALUES (v_f.id, v_no, p->>'bucket', p->>'path', v_sha, (p->>'size')::bigint, p->>'mime', v_actor, v_unmerged)
  RETURNING id INTO v_ver_id;
  IF NOT v_unmerged THEN
    PERFORM set_config('store.edit_confirmed', CASE WHEN v_confirmed THEN 'on' ELSE 'off' END, true);
    UPDATE public.store_files SET current_version_id = v_ver_id WHERE id = v_f.id;
    PERFORM set_config('store.edit_confirmed', 'off', true);
  END IF;
  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, details)
  VALUES ('version_added', v_actor, v_f.owner_id, v_f.id, v_f.folder_id, v_f.name,
          jsonb_strip_nulls(jsonb_build_object(
            'version_id', v_ver_id, 'version_no', v_no, 'sha256', v_sha, 'size', (p->>'size')::bigint,
            'source', v_source, 'base_version_no', v_expected, 'confirmed', v_confirmed, 'unmerged', v_unmerged,
            'reason', nullif(p->>'reason', ''), 'note', nullif(p->>'note', ''), 'device_id', nullif(p->>'device_id', ''),
            'ip', nullif(p->>'ip', ''), 'user_agent', nullif(p->>'user_agent', ''), 'client_visible', coalesce(v_f.published, false))));
  RETURN jsonb_build_object('status', CASE WHEN v_unmerged THEN 'unmerged' ELSE 'versioned' END, 'file_id', v_f.id,
                            'version_id', v_ver_id, 'version_no', v_no, 'name', v_f.name);
END $$;

-- one call for a whole folder's files: current version number, older copies, why it is locked, unmerged edits waiting
CREATE OR REPLACE FUNCTION public.store_files_edit_info(p_ids uuid[])
RETURNS TABLE (file_id uuid, lock_kind text, version_no integer, version_count integer, unmerged_pending integer)
LANGUAGE sql STABLE AS $$
  SELECT f.id, public.store_lock_class(f.id), cv.version_no,
         (SELECT count(*)::int FROM public.store_file_versions v WHERE v.file_id = f.id AND NOT v.unmerged),
         (SELECT count(*)::int FROM public.store_file_versions v WHERE v.file_id = f.id AND v.unmerged AND v.created_at > coalesce(cv.created_at, 'epoch'::timestamptz))
    FROM public.store_files f LEFT JOIN public.store_file_versions cv ON cv.id = f.current_version_id
   WHERE f.id = ANY(p_ids)
$$;

REVOKE ALL ON FUNCTION public.store_lock_class(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_files_edit_info(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_files_version_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_append_version(jsonb) FROM PUBLIC, anon, authenticated;

-- store_write, patched (generated from the original text: only the two changes named at the top)
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
    -- safe-save (2026-10-25): read the file AGAIN now that the owner lock is held (a save that committed in between must not be missed),
    -- and take the lock of the owner it belongs to NOW (a re-home may have moved it)
    SELECT id, owner_id, folder_id, state, filing_status, current_version_id, name INTO v_file
      FROM public.store_files WHERE id = v_file_id FOR UPDATE;
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
      VALUES (v_file.id, coalesce((SELECT max(version_no) FROM public.store_file_versions WHERE file_id = v_file.id), 0) + 1, p->>'bucket', p->>'path', v_sha, (p->>'size')::bigint, p->>'mime', v_actor)
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
