-- CRM Store — slice S2: the one server-side writer (2026-09-25, Antonio "continue with the project").
-- Master plan v4.4 §8.5 + §8.9 slice 2; dev job 685467b5. Builds on 20260924-2300-crm-store-foundation-s1.sql.
-- Revised after the S2 pre-apply council (5 core).
--
-- WHAT THIS ADDS (dark — nothing calls it yet):
--  * store_write(jsonb): the single database step every save goes through. Identity = the
--    caller key, GLOBALLY unique among non-purged files (a re-homed file keeps its key, so a
--    later re-save versions it where it now lives instead of re-creating the misfile). The
--    SHA-256 only decides same vs new version. Record links, subjects and facts are written in
--    the SAME transaction on every non-refused outcome (a crash can never leave a file unlinked).
--    Statuses: created | versioned | unchanged | frozen | trashed. The caller removes its
--    uploaded bytes for unchanged / frozen / trashed.
--  * Browser uploads: single-use upload slots + a private STAGING bucket. A staff browser may
--    upload (TUS, x-upsert false, its own session) ONLY to the exact staging path of a slot it
--    created. The server CLAIMS the slot (a lease, so a killed request can retry), moves the
--    object into crm-store and registers it; the slot is FINALISED only then.
--  * Cleanup: expired/abandoned slots, and crm-store objects no version refers to (orphans
--    from a killed request), are listed for the cleanup job, which removes them by code.

BEGIN;

-- ─────────────────────────────────────────────────────────────── caller keys: global, not purged
DROP INDEX IF EXISTS public.store_files_caller_key_uq;
CREATE UNIQUE INDEX IF NOT EXISTS store_files_caller_key_active_uq
  ON public.store_files (caller_key) WHERE state <> 'purged';

-- ─────────────────────────────────────────────────────────────── staging bucket + upload slots
INSERT INTO storage.buckets (id, name, public) VALUES ('crm-store-staging', 'crm-store-staging', false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.store_upload_intents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES public.store_owners(id) ON DELETE RESTRICT,
  folder_id     uuid NOT NULL REFERENCES public.store_folders(id) ON DELETE RESTRICT,
  created_by    uuid NOT NULL,
  file_name     text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  mime_type     text,
  caller_key    text,
  staging_path  text NOT NULL UNIQUE,            -- '<created_by>/<slot id>/<uuid>' in crm-store-staging
  expires_at    timestamptz NOT NULL,            -- the browser must finish uploading before this
  claimed_at    timestamptz,                     -- server started registering (lease)
  lease_until   timestamptz,
  dest_path     text,                            -- where the object is moved in crm-store
  consumed_at   timestamptz,                     -- finalised (registered) or closed by cleanup
  file_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_upload_intents_open_idx
  ON public.store_upload_intents (expires_at) WHERE consumed_at IS NULL;
ALTER TABLE public.store_upload_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_upload_intents FROM anon, authenticated, PUBLIC;

-- Used ONLY by the staging-bucket upload policy. SECURITY DEFINER because the slots table is
-- service-role only. Explicit staff allow-list (admin/team), never "everyone except client/partner".
CREATE OR REPLACE FUNCTION public.store_staging_upload_allowed(p_object_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) IN ('admin', 'team')
     AND EXISTS (
       SELECT 1 FROM public.store_upload_intents i
        WHERE i.staging_path = p_object_name
          AND i.created_by = auth.uid()
          AND i.claimed_at IS NULL
          AND i.consumed_at IS NULL
          AND i.expires_at > now()
     )
$$;
REVOKE ALL ON FUNCTION public.store_staging_upload_allowed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_staging_upload_allowed(text) TO authenticated;

DROP POLICY IF EXISTS crm_store_staging_insert_own_intent ON storage.objects;
CREATE POLICY crm_store_staging_insert_own_intent ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'crm-store-staging' AND public.store_staging_upload_allowed(name));
-- (no SELECT / UPDATE / DELETE policy: the browser can only create its one object)

-- Claim a slot for registration: a lease, so a request killed mid-way can be retried by the same
-- person with the same destination. Raises if unknown / finalised / not yours / lease still held.
CREATE OR REPLACE FUNCTION public.store_claim_intent(p_intent_id uuid, p_actor uuid, p_lease interval DEFAULT interval '15 minutes')
RETURNS public.store_upload_intents LANGUAGE plpgsql AS $$
DECLARE v public.store_upload_intents;
BEGIN
  UPDATE public.store_upload_intents
     SET claimed_at  = now(),
         lease_until = now() + p_lease,
         dest_path   = coalesce(dest_path, owner_id::text || '/' || gen_random_uuid()::text)
   WHERE id = p_intent_id AND created_by = p_actor AND consumed_at IS NULL
     AND (claimed_at IS NULL OR lease_until < now())
  RETURNING * INTO v;
  IF v.id IS NULL THEN
    RAISE EXCEPTION 'store: this upload slot is unknown, already registered, busy or not yours' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.store_finalize_intent(p_intent_id uuid, p_file_id uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE public.store_upload_intents SET consumed_at = now(), file_id = p_file_id
   WHERE id = p_intent_id AND consumed_at IS NULL
$$;

-- ─────────────────────────────────────────────────────────────── record links must belong to the file's owner
-- (a file can never be tied to another client's case, return or signature)
CREATE OR REPLACE FUNCTION public.store_link_belongs(p_owner_id uuid, p_kind text, p_record_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  o record;
BEGIN
  IF p_record_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.catalog_entries
                                          WHERE catalog_id = 'storage_link_kinds' AND slug = p_kind AND status = 'active') THEN
    RETURN false;
  END IF;
  SELECT * INTO o FROM public.store_owners WHERE id = p_owner_id;
  IF NOT FOUND OR o.kind = 'unfiled' THEN RETURN false; END IF;
  IF p_kind = 'service_case' THEN
    RETURN EXISTS (SELECT 1 FROM public.service_deliveries sd WHERE sd.id = p_record_id AND (
             (o.kind = 'company' AND sd.account_id = o.account_id)
          OR (o.kind = 'person' AND sd.contact_id = o.contact_id)
          OR (o.kind = 'formation' AND sd.id = o.service_delivery_id)));
  ELSIF p_kind = 'tax_return' THEN
    RETURN EXISTS (SELECT 1 FROM public.tax_returns t WHERE t.id = p_record_id AND (
             (o.kind = 'company' AND t.account_id = o.account_id) OR (o.kind = 'person' AND t.contact_id = o.contact_id)));
  ELSIF p_kind = 'signature_request' THEN
    RETURN EXISTS (SELECT 1 FROM public.signature_requests r WHERE r.id = p_record_id AND (
             (o.kind = 'company' AND r.account_id = o.account_id) OR (o.kind = 'person' AND r.contact_id = o.contact_id)
          OR (o.kind = 'formation' AND r.service_delivery_id = o.service_delivery_id)));
  ELSIF p_kind = 'esign_envelope' THEN
    RETURN EXISTS (SELECT 1 FROM public.esign_envelopes e WHERE e.id = p_record_id AND (
             (o.kind = 'company' AND e.owner_account_id = o.account_id) OR (o.kind = 'person' AND e.contact_id = o.contact_id)
          OR (o.kind = 'formation' AND e.service_delivery_id = o.service_delivery_id)));
  ELSIF p_kind = 'fax_transmission' THEN
    -- no fax table: the record is another stored file (the one that was faxed) of the same owner
    RETURN EXISTS (SELECT 1 FROM public.store_files f WHERE f.id = p_record_id AND f.owner_id = p_owner_id);
  END IF;
  RETURN false;
END $$;

-- ─────────────────────────────────────────────────────────────── the one write step
-- p jsonb keys: owner_id, folder_id, caller_key (nullable = always a new file), name, document_type,
-- period_year, filing_status, bucket, path, sha256, size, mime, actor, content_changed (default true;
-- false = a re-rendered document whose meaningful content did not change → never a new version),
-- published (NEW files only; default = the document type's default_published, or true when the file is
-- created in a client-safe stage of its REAL service case), supersedes_file_id (NEW files only: an amended
-- return points at the LIVE file it replaces — same owner, same type and year when both are set).
-- Links are validated: the kind must be an active storage_link_kinds row and the record must belong to
-- the file's owner; a service-case link's stage is read from the case itself, never from the caller.
-- links[] {kind, record_id, stage, tax_year}, subjects[] {kind: person|company, contact_id, account_id, role},
-- facts[] {key, value, source}.
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

-- Is this crm-store object referenced by any saved version? (the writer never deletes one that is)
CREATE OR REPLACE FUNCTION public.store_object_referenced(p_bucket text, p_path text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.store_file_versions WHERE storage_bucket = p_bucket AND storage_path = p_path)
$$;

-- Abandoned upload slots: never uploaded/claimed and expired, or claimed but never finalised
-- and the lease long gone. Returns what the cleanup job removes.
CREATE OR REPLACE FUNCTION public.store_abandoned_intents(p_limit integer DEFAULT 200)
RETURNS TABLE (id uuid, staging_path text, dest_path text) LANGUAGE sql STABLE AS $$
  SELECT i.id, i.staging_path, i.dest_path FROM public.store_upload_intents i
   WHERE i.consumed_at IS NULL
     AND ((i.claimed_at IS NULL AND i.expires_at < now() - interval '1 hour')
       OR (i.claimed_at IS NOT NULL AND i.lease_until < now() - interval '1 hour'))
   ORDER BY i.created_at LIMIT p_limit
$$;

-- crm-store objects no version refers to (killed requests), older than p_min_age.
CREATE OR REPLACE FUNCTION public.store_orphan_objects(p_min_age interval DEFAULT interval '6 hours', p_limit integer DEFAULT 200)
RETURNS TABLE (path text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, storage AS $$
  SELECT o.name FROM storage.objects o
   WHERE o.bucket_id = 'crm-store' AND o.created_at < now() - p_min_age
     AND NOT EXISTS (SELECT 1 FROM public.store_file_versions v WHERE v.storage_bucket = 'crm-store' AND v.storage_path = o.name)
     AND NOT EXISTS (SELECT 1 FROM public.store_upload_intents i WHERE i.dest_path = o.name AND i.consumed_at IS NULL)
   ORDER BY o.created_at LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION public.store_claim_intent(uuid, uuid, interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_finalize_intent(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_write(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_link_belongs(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_object_referenced(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_abandoned_intents(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_orphan_objects(interval, integer) FROM PUBLIC, anon, authenticated;

COMMIT;
