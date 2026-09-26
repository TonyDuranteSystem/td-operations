-- CRM Store — slice S4: trash with batch restore, the 90-day purge (with legal holds), "remove from
-- view", folder upload and folder zip listings (master plan v4.5 §8.6, §8.8, §8.9 #4; decisions #26,
-- #31, #61; job 685467b5). SANDBOX FIRST. Dark: nothing calls these yet, and the purge is NOT scheduled.
--
--   · Move to trash = the item leaves every view and stays restorable. One action = one batch. Each
--     trashed item carries its own purge_after date, fixed WHEN IT IS TRASHED (a later settings edit
--     never shortens it); the window is data (storage_settings/trash) and can never be under 90 days.
--   · Only CUSTOM folders can be trashed — never an owner's root or a template folder (1. Company …
--     5. Correspondence, personal, ITIN…): the fixed folder layout (and the Drive mirror) must hold.
--   · Restore puts items back where they were when that folder is live and has the same owner;
--     otherwise into a folder the caller names (same owner only). A taken name gets " (2)". An
--     amendment whose original has meanwhile been amended by another live file is not restored (two
--     current filings would show). Every trashed / restored item gets its own event.
--   · Purge: after purge_after, a file becomes a permanent tombstone (row, versions, history kept; its
--     links copied into the history and released). LEGAL HOLDS (#61, data in storage_purge_holds) keep
--     W-7s and the ID used for an ITIN for 3 years after their year, and filed tax returns forever: they
--     stay in the trash (still restorable) and are never purged while held. The bytes are removed by the
--     caller afterwards; store_purge_pending_objects() finds any removal that failed.
--   · "Remove from view" = remove ONE record link (the file leaves that staff workspace). It is never a
--     trash and does not change what the client sees (that is the publish switch).
-- Drive is not touched (slice 5).

BEGIN;

-- ─────────────────────────────────────────────────────────────── settings + holds (data)
INSERT INTO public.catalog_definitions (id, display_name, description, admin_can_add_rows)
SELECT v.id, v.display_name, v.description, v.can_add FROM (VALUES
  ('storage_settings', 'Storage — settings', 'Settings for the CRM store. Row "trash": metadata.trash_days (int, never below 90 — Antonio #31).', false),
  ('storage_purge_holds', 'Storage — purge holds', 'Trashed files the 90-day purge must NOT remove (Antonio #61). metadata: document_types[], folder_kinds[] / service_types[] (optional: either must match), filing_statuses[] (optional), years_after (int from the file''s year; null = forever).', true)
) AS v(id, display_name, description, can_add)
WHERE NOT EXISTS (SELECT 1 FROM public.catalog_definitions d WHERE d.id = v.id);

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
SELECT v.catalog_id, v.slug, v.display_name, 'active', v.metadata::jsonb FROM (VALUES
  ('storage_settings', 'trash', 'Trash', '{"trash_days":90}'),
  ('storage_purge_holds', 'itin_application', 'ITIN applications (IRS acceptance-agent 3-year rule)',
     '{"document_types":["form_w_7","form_w_7_coa"],"years_after":3}'),
  ('storage_purge_holds', 'itin_identity', 'ID documents used for an ITIN (IRS acceptance-agent 3-year rule)',
     '{"document_types":["passport","id_document"],"folder_kinds":["itin"],"service_types":["ITIN"],"years_after":3}'),
  ('storage_purge_holds', 'filed_tax_returns', 'Filed tax returns (never purged)',
     '{"document_types":["tax_return","form_1065","form_1120","form_1120_f","form_5472","form_1040_nr","form_7004","form_8804_8805_partnership_withholding"],"filing_statuses":["filed","amended"],"years_after":null}')
) AS v(catalog_id, slug, display_name, metadata)
WHERE NOT EXISTS (SELECT 1 FROM public.catalog_entries c WHERE c.catalog_id = v.catalog_id AND c.slug = v.slug);

-- the trash window in days: at least 90 (#31), at most 10 years; a bad value falls back to 90
CREATE OR REPLACE FUNCTION public.store_trash_days()
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT least(greatest(coalesce((
    SELECT CASE WHEN metadata->>'trash_days' ~ '^[0-9]{1,5}$' THEN (metadata->>'trash_days')::int END
      FROM public.catalog_entries WHERE catalog_id = 'storage_settings' AND slug = 'trash' AND status = 'active'), 90), 90), 3650)
$$;

-- ─────────────────────────────────────────────────────────────── schema
ALTER TABLE public.store_files   ADD COLUMN IF NOT EXISTS purge_after timestamptz;
ALTER TABLE public.store_folders ADD COLUMN IF NOT EXISTS purge_after timestamptz;
CREATE INDEX IF NOT EXISTS store_files_trash_batch_idx   ON public.store_files (trash_batch_id) WHERE trash_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS store_folders_trash_batch_idx ON public.store_folders (trash_batch_id) WHERE trash_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS store_files_purge_after_idx   ON public.store_files (purge_after) WHERE state = 'trashed';

-- Folder rules on top of S1: only custom folders are trashed, only through the trash function (it
-- works bottom-up), and nothing that sits in the trash can be re-homed to another owner.
CREATE OR REPLACE FUNCTION public.store_folders_trash_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.trashed_at IS NULL AND NEW.trashed_at IS NOT NULL THEN
    IF NEW.parent_id IS NULL OR NEW.kind <> 'custom' THEN
      RAISE EXCEPTION 'store: only folders staff created can be moved to trash (not the root or a standard folder)' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.store_folders c WHERE c.parent_id = NEW.id AND c.trashed_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.store_files f WHERE f.folder_id = NEW.id AND f.state = 'live') THEN
      RAISE EXCEPTION 'store: trash the folder with store_trash_folder (it still holds live items)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.owner_id <> OLD.owner_id AND OLD.trashed_at IS NOT NULL THEN
    RAISE EXCEPTION 'store: restore or leave items in the trash before moving them to another client' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_store_folders_trash_guard ON public.store_folders;
CREATE TRIGGER trg_store_folders_trash_guard BEFORE UPDATE ON public.store_folders
  FOR EACH ROW EXECUTE FUNCTION public.store_folders_trash_guard();

CREATE OR REPLACE FUNCTION public.store_files_trash_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id AND OLD.state = 'trashed' THEN
    RAISE EXCEPTION 'store: restore or leave items in the trash before moving them to another client' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_store_files_trash_guard ON public.store_files;
CREATE TRIGGER trg_store_files_trash_guard BEFORE UPDATE ON public.store_files
  FOR EACH ROW EXECUTE FUNCTION public.store_files_trash_guard();

-- a free name in a folder: the name itself, else " (2)", " (3)"… within 255 characters
CREATE OR REPLACE FUNCTION public.store_free_name(p_folder_id uuid, p_name text, p_for_folder boolean)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_owner uuid;
  v_ext text := CASE WHEN p_for_folder THEN '' ELSE coalesce(substring(p_name from '(\.[A-Za-z0-9]{1,10})$'), '') END;
  v_base text := left(p_name, length(p_name) - length(v_ext));
  v_try text := p_name;
  v_n int := 1;
BEGIN
  SELECT owner_id INTO v_owner FROM public.store_folders WHERE id = p_folder_id;
  LOOP
    EXIT WHEN CASE WHEN p_for_folder
      THEN NOT EXISTS (SELECT 1 FROM public.store_folders WHERE owner_id = v_owner AND parent_id = p_folder_id AND name_key = public.store_name_key(v_try))
      ELSE NOT EXISTS (SELECT 1 FROM public.store_files WHERE folder_id = p_folder_id AND name_key = public.store_name_key(v_try)) END;
    v_n := v_n + 1;
    IF v_n > 500 THEN RAISE EXCEPTION 'store: too many items named % here', p_name; END IF;
    v_try := left(v_base, 255 - length(v_ext) - length(' (' || v_n || ')')) || ' (' || v_n || ')' || v_ext;
  END LOOP;
  RETURN v_try;
END $$;

-- ─────────────────────────────────────────────────────────────── legal holds (#61)
-- The hold (slug) that keeps this file from being purged today, or NULL.
CREATE OR REPLACE FUNCTION public.store_file_purge_hold(p_file_id uuid, p_today date DEFAULT current_date)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT h.slug
    FROM public.store_files f
    JOIN public.store_folders d ON d.id = f.folder_id
    JOIN public.catalog_entries h ON h.catalog_id = 'storage_purge_holds' AND h.status = 'active'
   WHERE f.id = p_file_id
     AND h.metadata->'document_types' ? coalesce(f.document_type, '')
     AND (h.metadata->'filing_statuses' IS NULL OR h.metadata->'filing_statuses' ? f.filing_status)
     AND ( (h.metadata->'folder_kinds' IS NULL AND h.metadata->'service_types' IS NULL)
        OR h.metadata->'folder_kinds' ? d.kind
        OR EXISTS (SELECT 1 FROM public.store_record_links l JOIN public.service_deliveries sd ON sd.id = l.record_id
                    WHERE l.file_id = f.id AND l.link_kind = 'service_case' AND h.metadata->'service_types' ? sd.service_type) )
     AND ( h.metadata->'years_after' IS NULL OR jsonb_typeof(h.metadata->'years_after') = 'null'
        OR make_date(coalesce(f.period_year, extract(year FROM f.created_at)::int) + (h.metadata->>'years_after')::int, 12, 31) >= p_today )
   ORDER BY h.slug LIMIT 1
$$;

-- ─────────────────────────────────────────────────────────────── move to trash (staff action)
CREATE OR REPLACE FUNCTION public.store_trash_file(p_file_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_owner uuid;
  v_batch uuid := gen_random_uuid();
  v_until timestamptz := now() + make_interval(days => public.store_trash_days());
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'store: moving a file to trash needs the staff member who did it'; END IF;
  SELECT owner_id INTO v_owner FROM public.store_files WHERE id = p_file_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'store: no such file'; END IF;
  PERFORM public.store_lock_owner(v_owner);                    -- same lock order as folder trash / restore
  SELECT id, owner_id, folder_id, name, state, filing_status INTO f FROM public.store_files WHERE id = p_file_id FOR UPDATE;
  IF f.state <> 'live' THEN RAISE EXCEPTION 'store: only a live file can be moved to trash'; END IF;
  UPDATE public.store_files SET state = 'trashed', trashed_at = now(), trashed_by = p_actor, trash_batch_id = v_batch, purge_after = v_until
   WHERE id = p_file_id;
  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, reason, details)
  VALUES ('trashed', p_actor, f.owner_id, f.id, f.folder_id, f.name, p_reason,
          jsonb_build_object('batch_id', v_batch, 'filing_status', f.filing_status, 'purge_after', v_until));
  RETURN v_batch;
END $$;

-- a custom folder and everything live under it, as ONE batch, bottom-up, one event per item
CREATE OR REPLACE FUNCTION public.store_trash_folder(p_folder_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  d record;
  r record;
  x record;
  v_owner uuid;
  v_batch uuid := gen_random_uuid();
  v_until timestamptz := now() + make_interval(days => public.store_trash_days());
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'store: moving a folder to trash needs the staff member who did it'; END IF;
  SELECT owner_id INTO v_owner FROM public.store_folders WHERE id = p_folder_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'store: no such folder'; END IF;
  PERFORM public.store_lock_owner(v_owner);
  -- re-read under the lock: a second click that waited for the first sees it already trashed
  SELECT id, owner_id, parent_id, name, kind, trashed_at INTO d FROM public.store_folders WHERE id = p_folder_id FOR UPDATE;
  IF d.trashed_at IS NOT NULL THEN RAISE EXCEPTION 'store: this folder is already in the trash'; END IF;
  IF d.parent_id IS NULL OR d.kind <> 'custom' THEN
    RAISE EXCEPTION 'store: only folders staff created can be moved to trash (not the root or a standard folder)';
  END IF;
  FOR r IN
    WITH RECURSIVE t(id, depth) AS (
      SELECT id, 0 FROM public.store_folders WHERE id = p_folder_id AND trashed_at IS NULL
      UNION ALL
      SELECT c.id, t.depth + 1 FROM public.store_folders c JOIN t ON c.parent_id = t.id
       WHERE c.trashed_at IS NULL AND t.depth < 1000
    ) SELECT id, depth FROM t ORDER BY depth DESC
  LOOP
    FOR x IN UPDATE public.store_files SET state = 'trashed', trashed_at = now(), trashed_by = p_actor, trash_batch_id = v_batch, purge_after = v_until
              WHERE folder_id = r.id AND state = 'live'
              RETURNING id, folder_id, name, filing_status LOOP
      INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, reason, details)
      VALUES ('trashed', p_actor, v_owner, x.id, x.folder_id, x.name, p_reason,
              jsonb_build_object('batch_id', v_batch, 'filing_status', x.filing_status, 'purge_after', v_until, 'with_folder', p_folder_id));
    END LOOP;
    UPDATE public.store_folders SET trashed_at = now(), trashed_by = p_actor, trash_batch_id = v_batch, purge_after = v_until
     WHERE id = r.id AND trashed_at IS NULL
     RETURNING id, name INTO x;
    INSERT INTO public.store_events (event, actor, owner_id, folder_id, name_snapshot, reason, details)
    VALUES ('trashed', p_actor, v_owner, x.id, x.name, p_reason, jsonb_build_object('batch_id', v_batch, 'purge_after', v_until, 'with_folder', p_folder_id));
  END LOOP;
  RETURN v_batch;
END $$;

-- ─────────────────────────────────────────────────────────────── restore a batch
-- p_target_folder: where to put top-level items whose original folder is gone (same owner only).
-- Anything not yet purged is restorable (a held or not-yet-swept file stays restorable).
-- Returns {restored:[…], skipped:[…]}; one event per restored item.
CREATE OR REPLACE FUNCTION public.store_restore_batch(p_batch_id uuid, p_actor uuid, p_target_folder uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid;
  v_target record;
  r record;
  v_parent uuid;
  v_name text;
  v_restored jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'store: restoring needs the staff member who did it'; END IF;
  SELECT owner_id INTO v_owner FROM (
    SELECT owner_id FROM public.store_files WHERE trash_batch_id = p_batch_id AND state = 'trashed'
    UNION SELECT owner_id FROM public.store_folders WHERE trash_batch_id = p_batch_id AND trashed_at IS NOT NULL) x LIMIT 1;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'store: nothing restorable in the trash with that batch'; END IF;
  PERFORM public.store_lock_owner(v_owner);
  IF (SELECT count(DISTINCT owner_id) FROM (
        SELECT owner_id FROM public.store_files WHERE trash_batch_id = p_batch_id AND state = 'trashed'
        UNION ALL SELECT owner_id FROM public.store_folders WHERE trash_batch_id = p_batch_id AND trashed_at IS NOT NULL) y) > 1 THEN
    RAISE EXCEPTION 'store: a trash batch spans owners — refused';
  END IF;
  -- a batch whose files have all been purged is over: folders alone are not brought back as empty shells
  IF NOT EXISTS (SELECT 1 FROM public.store_files WHERE trash_batch_id = p_batch_id AND state = 'trashed')
     AND EXISTS (SELECT 1 FROM public.store_files WHERE trash_batch_id = p_batch_id AND state = 'purged') THEN
    RAISE EXCEPTION 'store: everything in this batch has been permanently deleted';
  END IF;
  IF p_target_folder IS NOT NULL THEN
    SELECT id, owner_id, trashed_at INTO v_target FROM public.store_folders WHERE id = p_target_folder;
    IF NOT FOUND OR v_target.owner_id <> v_owner OR v_target.trashed_at IS NOT NULL THEN
      RAISE EXCEPTION 'store: the restore target must be a live folder of the same client' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- folders, top-down (a folder's parent is restored before it)
  FOR r IN
    WITH RECURSIVE b AS (
      SELECT f.id, f.parent_id, f.name, 0 AS depth FROM public.store_folders f
       WHERE f.trash_batch_id = p_batch_id AND f.trashed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.store_folders p WHERE p.id = f.parent_id AND p.trash_batch_id = p_batch_id AND p.trashed_at IS NOT NULL)
      UNION ALL
      SELECT c.id, c.parent_id, c.name, b.depth + 1 FROM public.store_folders c JOIN b ON c.parent_id = b.id
       WHERE c.trash_batch_id = p_batch_id AND c.trashed_at IS NOT NULL AND b.depth < 1000
    ) SELECT * FROM b ORDER BY depth
  LOOP
    v_parent := r.parent_id;
    IF r.depth = 0 AND NOT EXISTS (SELECT 1 FROM public.store_folders p
                                    WHERE p.id = r.parent_id AND p.owner_id = v_owner AND p.trashed_at IS NULL) THEN
      IF p_target_folder IS NULL THEN
        RAISE EXCEPTION 'store: the original folder of "%" is gone — choose where to restore it', r.name USING ERRCODE = 'check_violation';
      END IF;
      v_parent := p_target_folder;
    END IF;
    v_name := public.store_free_name(v_parent, r.name, true);
    UPDATE public.store_folders SET trashed_at = NULL, trashed_by = NULL, trash_batch_id = NULL, purge_after = NULL, parent_id = v_parent, name = v_name
     WHERE id = r.id;
    INSERT INTO public.store_events (event, actor, owner_id, folder_id, name_snapshot, details)
    VALUES ('restored', p_actor, v_owner, r.id, v_name, jsonb_build_object('batch_id', p_batch_id, 'from_name', r.name, 'parent_id', v_parent));
    v_restored := v_restored || jsonb_build_object('kind','folder','id',r.id,'name',v_name,'renamed',v_name <> r.name);
  END LOOP;

  -- files
  FOR r IN SELECT id, folder_id, name, state, supersedes_file_id FROM public.store_files
            WHERE trash_batch_id = p_batch_id AND state IN ('trashed','purged') ORDER BY name LOOP
    IF r.state = 'purged' THEN
      v_skipped := v_skipped || jsonb_build_object('kind','file','id',r.id,'name',r.name,'why','permanently deleted');
      CONTINUE;
    END IF;
    IF r.supersedes_file_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.store_files n WHERE n.supersedes_file_id = r.supersedes_file_id AND n.id <> r.id AND n.state = 'live') THEN
      v_skipped := v_skipped || jsonb_build_object('kind','file','id',r.id,'name',r.name,
                                  'why','the original was amended again by another file — restoring this would show two current filings');
      CONTINUE;
    END IF;
    v_parent := r.folder_id;
    IF NOT EXISTS (SELECT 1 FROM public.store_folders p WHERE p.id = r.folder_id AND p.owner_id = v_owner AND p.trashed_at IS NULL) THEN
      IF p_target_folder IS NULL THEN
        RAISE EXCEPTION 'store: the original folder of "%" is gone — choose where to restore it', r.name USING ERRCODE = 'check_violation';
      END IF;
      v_parent := p_target_folder;
    END IF;
    v_name := public.store_free_name(v_parent, r.name, false);
    UPDATE public.store_files SET state = 'live', trashed_at = NULL, trashed_by = NULL, trash_batch_id = NULL, purge_after = NULL,
                                  folder_id = v_parent, name = v_name
     WHERE id = r.id;
    INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, details)
    VALUES ('restored', p_actor, v_owner, r.id, v_parent, v_name, jsonb_build_object('batch_id', p_batch_id, 'from_name', r.name, 'from_folder', r.folder_id));
    v_restored := v_restored || jsonb_build_object('kind','file','id',r.id,'name',v_name,'renamed',v_name <> r.name);
  END LOOP;
  RETURN jsonb_build_object('restored', v_restored, 'skipped', v_skipped);
END $$;

-- What is in the trash (optionally for one owner): one row per batch that still holds something restorable.
DROP FUNCTION IF EXISTS public.store_trash_list(uuid);
CREATE OR REPLACE FUNCTION public.store_trash_list(p_owner_id uuid DEFAULT NULL)
RETURNS TABLE (batch_id uuid, owner_id uuid, trashed_at timestamptz, purge_after timestamptz, trashed_by uuid,
               top_name text, folders bigint, files bigint, held_files bigint)
LANGUAGE sql STABLE AS $$
  WITH items AS (
    SELECT f.trash_batch_id, f.owner_id, f.trashed_at, f.purge_after, f.trashed_by, f.name, 'file' AS kind,
           EXISTS (SELECT 1 FROM public.store_folders p WHERE p.id = f.folder_id AND p.trash_batch_id = f.trash_batch_id AND p.trashed_at IS NOT NULL) AS nested,
           public.store_file_purge_hold(f.id) IS NOT NULL AS held
      FROM public.store_files f WHERE f.state = 'trashed'
    UNION ALL
    SELECT d.trash_batch_id, d.owner_id, d.trashed_at, d.purge_after, d.trashed_by, d.name, 'folder',
           EXISTS (SELECT 1 FROM public.store_folders p WHERE p.id = d.parent_id AND p.trash_batch_id = d.trash_batch_id AND p.trashed_at IS NOT NULL),
           false
      FROM public.store_folders d
     WHERE d.trashed_at IS NOT NULL AND d.trash_batch_id IS NOT NULL
       AND NOT (NOT EXISTS (SELECT 1 FROM public.store_files x WHERE x.trash_batch_id = d.trash_batch_id AND x.state = 'trashed')
                AND EXISTS (SELECT 1 FROM public.store_files x WHERE x.trash_batch_id = d.trash_batch_id AND x.state = 'purged'))
  )
  SELECT i.trash_batch_id, min(i.owner_id::text)::uuid, min(i.trashed_at), min(i.purge_after), (array_agg(i.trashed_by))[1],
         (array_agg(i.name ORDER BY i.kind DESC) FILTER (WHERE NOT i.nested))[1],
         count(*) FILTER (WHERE i.kind = 'folder'), count(*) FILTER (WHERE i.kind = 'file'), count(*) FILTER (WHERE i.held)
    FROM items i
   WHERE (p_owner_id IS NULL OR i.owner_id = p_owner_id)
   GROUP BY i.trash_batch_id
$$;

-- ─────────────────────────────────────────────────────────────── the purge
-- "now" for the purge is the database clock; a later clock is accepted only inside a proof run
-- (SET LOCAL store.purge_clock_test = 'on'), never from a caller's argument alone.
CREATE OR REPLACE FUNCTION public.store_purge_clock(p_now timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN coalesce(current_setting('store.purge_clock_test', true), '') = 'on' THEN coalesce(p_now, now())
              ELSE least(coalesce(p_now, now()), now()) END
$$;

-- Files due for purge: past their own purge_after and not under a hold.
CREATE OR REPLACE FUNCTION public.store_purge_due(p_now timestamptz DEFAULT now(), p_limit integer DEFAULT 200)
RETURNS TABLE (file_id uuid) LANGUAGE sql STABLE AS $$
  SELECT id FROM public.store_files
   WHERE state = 'trashed' AND purge_after IS NOT NULL AND purge_after < public.store_purge_clock(p_now)
     AND public.store_file_purge_hold(id, public.store_purge_clock(p_now)::date) IS NULL
   ORDER BY purge_after LIMIT p_limit
$$;

-- Turn one due file into a permanent tombstone. Row + versions + history stay; links, subjects, tags
-- and facts are copied into the history and removed (a purged file must not block deleting a CRM
-- record). Returns the storage objects the caller must now remove. Not due / held / restored → says so.
CREATE OR REPLACE FUNCTION public.store_purge_file(p_file_id uuid, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_owner uuid;
  v_now timestamptz := public.store_purge_clock(p_now);
  v_hold text;
  v_objects jsonb;
  v_kept jsonb;
BEGIN
  SELECT owner_id INTO v_owner FROM public.store_files WHERE id = p_file_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'store: no such file'; END IF;
  PERFORM public.store_lock_owner(v_owner);
  SELECT id, owner_id, folder_id, name, state, purge_after INTO f FROM public.store_files WHERE id = p_file_id FOR UPDATE;
  IF f.state = 'purged' THEN RETURN jsonb_build_object('status','already_purged'); END IF;
  IF f.state <> 'trashed' OR f.purge_after IS NULL OR f.purge_after >= v_now THEN RETURN jsonb_build_object('status','not_due'); END IF;
  v_hold := public.store_file_purge_hold(p_file_id, v_now::date);
  IF v_hold IS NOT NULL THEN RETURN jsonb_build_object('status','held','hold',v_hold); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', storage_bucket, 'path', storage_path)), '[]'::jsonb) INTO v_objects
    FROM public.store_file_versions WHERE file_id = p_file_id;
  SELECT jsonb_build_object(
           'links',    coalesce((SELECT jsonb_agg(to_jsonb(l) - 'file_id') FROM public.store_record_links l WHERE l.file_id = p_file_id), '[]'::jsonb),
           'subjects', coalesce((SELECT jsonb_agg(to_jsonb(s) - 'file_id') FROM public.store_file_subjects s WHERE s.file_id = p_file_id), '[]'::jsonb),
           'tags',     coalesce((SELECT jsonb_agg(to_jsonb(t) - 'file_id') FROM public.store_file_tags t WHERE t.file_id = p_file_id), '[]'::jsonb),
           'facts',    coalesce((SELECT jsonb_agg(to_jsonb(x) - 'file_id') FROM public.store_file_facts x WHERE x.file_id = p_file_id), '[]'::jsonb))
    INTO v_kept;
  DELETE FROM public.store_record_links  WHERE file_id = p_file_id;
  DELETE FROM public.store_file_subjects WHERE file_id = p_file_id;
  DELETE FROM public.store_file_tags     WHERE file_id = p_file_id;
  DELETE FROM public.store_file_facts    WHERE file_id = p_file_id;
  UPDATE public.store_files SET state = 'purged', purged_at = now() WHERE id = p_file_id;
  INSERT INTO public.store_events (event, owner_id, file_id, folder_id, name_snapshot, details)
  VALUES ('purged', f.owner_id, f.id, f.folder_id, f.name, jsonb_build_object('objects', v_objects, 'kept', v_kept, 'purge_after', f.purge_after));
  RETURN jsonb_build_object('status','purged','objects', v_objects);
END $$;

-- Bytes of purged files still present in the bucket (a removal that failed) — the purge job retries these.
CREATE OR REPLACE FUNCTION public.store_purge_pending_objects(p_limit integer DEFAULT 200)
RETURNS TABLE (bucket text, path text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, storage AS $$
  SELECT v.storage_bucket, v.storage_path
    FROM public.store_file_versions v JOIN public.store_files f ON f.id = v.file_id
   WHERE f.state = 'purged'
     AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = v.storage_bucket AND o.name = v.storage_path)
   ORDER BY f.purged_at, v.storage_path
   LIMIT p_limit
$$;

-- ─────────────────────────────────────────────────────────────── "remove from view" (not trash)
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

-- ─────────────────────────────────────────────────────────────── folder upload: nested folders
-- Create (or find) the folder path under p_parent — idempotent, custom folders, same checks as any
-- folder; p_owner must be the parent's owner (a mismatched request creates nothing). Returns the leaf.
CREATE OR REPLACE FUNCTION public.store_ensure_folder_path(p_owner uuid, p_parent uuid, p_path text[], p_actor uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid;
  v_cur uuid := p_parent;
  v_next uuid;
  v_seg text;
BEGIN
  SELECT owner_id INTO v_owner FROM public.store_folders WHERE id = p_parent AND trashed_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'store: upload into a live folder only'; END IF;
  IF v_owner IS DISTINCT FROM p_owner THEN RAISE EXCEPTION 'store: that folder belongs to a different client' USING ERRCODE = 'check_violation'; END IF;
  PERFORM public.store_lock_owner(v_owner);
  FOREACH v_seg IN ARRAY coalesce(p_path, ARRAY[]::text[]) LOOP
    v_seg := btrim(v_seg);
    IF v_seg = '' OR v_seg IN ('.','..') OR v_seg ~ '[/\\[:cntrl:]]' OR length(v_seg) > 255 THEN
      RAISE EXCEPTION 'store: invalid folder name in the upload path';
    END IF;
    SELECT id INTO v_next FROM public.store_folders
     WHERE owner_id = v_owner AND parent_id = v_cur AND name_key = public.store_name_key(v_seg);
    IF v_next IS NULL THEN
      INSERT INTO public.store_folders (owner_id, parent_id, kind, name, created_by)
      VALUES (v_owner, v_cur, 'custom', v_seg, p_actor) RETURNING id INTO v_next;
      INSERT INTO public.store_events (event, actor, owner_id, folder_id, name_snapshot, details)
      VALUES ('folder_created', p_actor, v_owner, v_next, v_seg, jsonb_build_object('via','folder_upload','parent_id',v_cur));
    END IF;
    v_cur := v_next;
    v_next := NULL;
  END LOOP;
  RETURN v_cur;
END $$;
DROP FUNCTION IF EXISTS public.store_ensure_folder_path(uuid, text[], uuid);

-- ─────────────────────────────────────────────────────────────── folder zip: the per-file listing
-- Every live file under p_folder_id with its path inside the zip. For a portal viewer (contact XOR
-- teammate) ONLY files that pass the slice-3 per-file check are listed; for staff (p_staff and no
-- viewer) every live file. The caller (lib/crm-store/folders.ts) makes names safe for every OS.
CREATE OR REPLACE FUNCTION public.store_folder_zip_listing(p_folder_id uuid, p_contact_id uuid, p_teammate_id uuid, p_staff boolean DEFAULT false)
RETURNS TABLE (file_id uuid, zip_path text, bucket text, object_path text, size_bytes bigint)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE tree(id, rel, depth) AS (
    SELECT id, ''::text, 0 FROM public.store_folders WHERE id = p_folder_id AND trashed_at IS NULL
    UNION ALL
    SELECT c.id, tree.rel || c.name || '/', tree.depth + 1 FROM public.store_folders c JOIN tree ON c.parent_id = tree.id
     WHERE c.trashed_at IS NULL AND tree.depth < 64
  )
  SELECT f.id, t.rel || f.name, v.storage_bucket, v.storage_path, v.size_bytes
    FROM tree t
    JOIN public.store_files f ON f.folder_id = t.id AND f.state = 'live'
    JOIN public.store_file_versions v ON v.id = f.current_version_id
   WHERE (p_staff AND p_contact_id IS NULL AND p_teammate_id IS NULL)
      OR (NOT p_staff AND public.store_file_access(f.id, p_contact_id, p_teammate_id) IN ('ok','ok_leaving'))
   ORDER BY 2
$$;

REVOKE ALL ON FUNCTION public.store_trash_days() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_folders_trash_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_files_trash_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_free_name(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_file_purge_hold(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_trash_file(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_trash_folder(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_restore_batch(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_trash_list(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_purge_clock(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_purge_due(timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_purge_file(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_purge_pending_objects(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_remove_link(uuid, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_ensure_folder_path(uuid, uuid, text[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_folder_zip_listing(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

COMMIT;
