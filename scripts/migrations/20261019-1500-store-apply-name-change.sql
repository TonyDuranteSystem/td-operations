-- Change Name, Track S2 (2026-10-19, dev job 26e97288, parent bb64c417): the SYSTEM moves a company's old folders when it changes name.
--
-- A company has ONE storage (one owner row per account) with ONE top folder, and the top folder cannot move. So when the
-- company changes its name:
--   * the top folder is renamed IN PLACE to the new name;
--   * the four fixed folders that hold content (1. Company, 3. Tax, 4. Banking, 5. Correspondence) — with every sub-folder
--     and file inside them — are moved, whole, into  "Previous names" › "<old name>"  (both locked: they carry a template slug);
--   * "2. Contacts" stays where it is (it is only a view of the company's people);
--   * a fresh standard set of the four folders is created under the top folder — the company continues there.
-- No FILE row is touched (files keep their ids, versions, links, CRM pointers `store:<file id>`): only folder rows move.
--
-- FUNCTIONS (all plain functions like the other store_* ones; EXECUTE for the service role only):
--   store_safe_folder_name(text)                                       folder-safe version of a name (same rule as storeSafeFolderName in code)
--   store_apply_name_change(owner, change_id, old_name, new_name, actor, dry_run)
--   store_undo_name_change(owner, change_id, actor, dry_run)           bounded undo of the LATEST change only
--   store_apply_name_change_for_account(account, change_id, new_name, expected_old_name, actor, dry_run)
--   store_undo_name_change_for_account(account, change_id, actor, dry_run)
-- The two *_for_account wrappers do the account compare-and-set + previous_name + append-only history AND the storage move in
-- ONE transaction (one function call): either everything happens or nothing does. Track B calls the wrappers.
--
-- RESULTS (jsonb): status = applied | already_applied | skipped | dry_run | conflict | undone | already_undone.
--   * REFUSALS RAISE (check_violation, message starts "store: name change refused —") so a wrapper call rolls the account back too:
--     a case-only rename, a name the root already has, a storage that is not the standard shape, anything unexpected under the top folder.
--   * SKIPS never raise (the caller has already decided to rename the account): not a company storage (formation/person/…),
--     a study copy (study_only), no storage at all (a company still on Drive) -> {status:'skipped', reason:…}.
--   * IDEMPOTENT BY MARKER, not by tree shape: the 'name_change_applied' store_events row carries change_id. A retry / second click
--     returns already_applied and moves nothing (the fresh folders and new files are never swept into a second archive).
--   * dry_run=true runs every check and writes nothing (it does not even take the owner lock).
--
-- UNDO is bounded: only the latest not-yet-undone change; refused unless the NEW fixed folders hold no files and no sub-folders and
-- the archive holds exactly the four moved folders; privileged-deletes ONLY the folders that change created; moves the four back;
-- renames the top folder back — one transaction. (Drive backup: empty folders it already made for the new set stay in the backup
-- Drive as unused empty folders.)
--
-- PRODUCTION: paste this whole block into the Supabase SQL editor AFTER 20261019-1400-accounts-previous-name.sql (R105: sandbox first —
-- applied there by node scripts/apply-migration.js). Matching rollback: 20261019-1500-store-apply-name-change.UNDO.sql.
-- It creates functions only (no table, no data change); nothing runs until Track B calls a wrapper.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────── preflight (raises = nothing changes)
DO $$
BEGIN
  IF to_regprocedure('public.store_lock_owner(uuid)') IS NULL THEN RAISE EXCEPTION 'preflight: store_lock_owner(uuid) not found'; END IF;
  IF to_regprocedure('public.store_apply_template(uuid,text,text,uuid)') IS NULL THEN RAISE EXCEPTION 'preflight: store_apply_template not found'; END IF;
  IF to_regprocedure('public.store_rename_root(uuid,text,uuid)') IS NULL THEN RAISE EXCEPTION 'preflight: store_rename_root not found'; END IF;
  IF to_regprocedure('public.store_free_name(uuid,text,boolean)') IS NULL THEN RAISE EXCEPTION 'preflight: store_free_name not found'; END IF;
  IF to_regprocedure('public.store_name_key(text)') IS NULL THEN RAISE EXCEPTION 'preflight: store_name_key not found'; END IF;
  IF to_regprocedure('public.store_is_privileged()') IS NULL THEN RAISE EXCEPTION 'preflight: store_is_privileged not found'; END IF;
  IF to_regclass('public.store_owners') IS NULL OR to_regclass('public.store_folders') IS NULL
     OR to_regclass('public.store_files') IS NULL OR to_regclass('public.store_events') IS NULL THEN
    RAISE EXCEPTION 'preflight: a store table is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_owners' AND column_name = 'study_only') THEN
    RAISE EXCEPTION 'preflight: store_owners.study_only not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'storage_folder_templates' AND slug = 'company_standard' AND status = 'active') THEN
    RAISE EXCEPTION 'preflight: the company_standard folder template is not active';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name IN ('previous_name', 'name_history')) <> 2 THEN
    RAISE EXCEPTION 'preflight: accounts.previous_name / accounts.name_history not found — run 20261019-1400-accounts-previous-name.sql first';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────── helper: a folder-safe name (same rule as storeSafeFolderName in code)
-- "/", "\" and control characters (which the folder-name CHECK refuses) become "-", runs of spaces collapse, trimmed, 255 characters, never empty.
CREATE OR REPLACE FUNCTION public.store_safe_folder_name(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(nullif(left(btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[/\\[:cntrl:]]', '-', 'g'), '[[:space:]]+', ' ', 'g')), 255), ''), 'Company')
$$;

-- ─────────────────────────────────────────────────────────────── the move
CREATE OR REPLACE FUNCTION public.store_apply_name_change(
  p_owner_id uuid, p_change_id uuid, p_old_name text, p_new_name text,
  p_actor uuid DEFAULT NULL, p_dry_run boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  c_template  constant text   := 'company_standard';
  c_archive   constant text   := 'name_change_archive';          -- template_slug of the two archive folders: it is what locks them
  c_fixed     constant text[] := ARRAY['company', 'contacts', 'tax', 'banking', 'correspondence'];
  c_moved     constant text[] := ARRAY['company', 'tax', 'banking', 'correspondence'];
  v_owner       record;
  v_root        record;
  v_marker      record;
  v_new_root    text := public.store_safe_folder_name(p_new_name);
  v_old_root    text;
  v_problem     text;
  v_kind        text;
  v_n           integer;
  v_extra       text;
  v_contacts    uuid;
  v_arch_root   uuid;
  v_arch_root_name text;
  v_arch_root_created boolean := false;
  v_arch_child  uuid;
  v_arch_child_name text;
  v_moved       jsonb := '{}'::jsonb;
  v_created     jsonb := '{}'::jsonb;
  v_id          uuid;
  v_details     jsonb;
BEGIN
  IF p_owner_id IS NULL OR p_change_id IS NULL THEN
    RAISE EXCEPTION 'store: a name change needs the storage and a change id' USING ERRCODE = 'check_violation';
  END IF;
  IF p_new_name IS NULL OR btrim(p_new_name) = '' THEN
    RAISE EXCEPTION 'store: a name change needs the new name' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT p_dry_run THEN PERFORM public.store_lock_owner(p_owner_id); END IF;

  -- who can be moved at all: a refusal to move is a structured skip, never an error (the caller already renamed the account)
  SELECT * INTO v_owner FROM public.store_owners WHERE id = p_owner_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_storage', 'owner_id', p_owner_id, 'dry_run', p_dry_run);
  END IF;
  IF v_owner.kind <> 'company' THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'not_company', 'owner_kind', v_owner.kind, 'owner_id', p_owner_id, 'dry_run', p_dry_run);
  END IF;
  IF v_owner.study_only THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'study_only', 'owner_id', p_owner_id, 'dry_run', p_dry_run);
  END IF;

  -- idempotent by MARKER: this change is already applied (and not undone since)
  SELECT e.id, e.event, e.details INTO v_marker FROM public.store_events e
   WHERE e.owner_id = p_owner_id AND e.event IN ('name_change_applied', 'name_change_undone') AND e.details->>'change_id' = p_change_id::text
   ORDER BY e.id DESC LIMIT 1;
  IF FOUND AND v_marker.event = 'name_change_applied' THEN
    RETURN jsonb_build_object('status', 'already_applied', 'owner_id', p_owner_id, 'dry_run', p_dry_run) || v_marker.details;
  END IF;

  -- preconditions: the standard shape, and a real (not case-only) change
  SELECT * INTO v_root FROM public.store_folders WHERE owner_id = p_owner_id AND parent_id IS NULL AND trashed_at IS NULL;
  IF NOT FOUND THEN
    v_problem := 'the storage has no top folder';
  ELSE
    v_old_root := v_root.name;
    IF v_root.template_slug IS DISTINCT FROM c_template THEN
      v_problem := format('the top folder was not made from the standard company template (%s)', coalesce(v_root.template_slug, 'no template'));
    ELSIF public.store_name_key(v_old_root) = public.store_name_key(v_new_root)
          OR (p_old_name IS NOT NULL AND public.store_name_key(p_old_name) = public.store_name_key(p_new_name)) THEN
      v_problem := 'the new name differs only by capital letters or spacing (or the folder already has it) — that is a correction, not a name change';
    END IF;
  END IF;
  IF v_problem IS NULL THEN
    FOREACH v_kind IN ARRAY c_fixed LOOP
      SELECT count(*) INTO v_n FROM public.store_folders WHERE parent_id = v_root.id AND trashed_at IS NULL AND kind = v_kind;
      IF v_n <> 1 THEN
        v_problem := format('expected exactly one "%s" folder directly under the top folder, found %s', v_kind, v_n);
        EXIT;
      END IF;
    END LOOP;
  END IF;
  IF v_problem IS NULL THEN
    SELECT string_agg('"' || name || '"', ', ' ORDER BY name) INTO v_extra FROM public.store_folders
     WHERE parent_id = v_root.id AND trashed_at IS NULL AND kind <> ALL (c_fixed) AND NOT (kind = 'custom' AND template_slug IS NOT DISTINCT FROM c_archive);   -- (a plain staff folder has a NULL slug: NULL-safe on purpose)
    IF v_extra IS NOT NULL THEN
      v_problem := format('unexpected folder(s) directly under the top folder: %s — move them inside one of the standard folders first', v_extra);
    END IF;
  END IF;
  IF v_problem IS NULL THEN
    SELECT count(*) INTO v_n FROM public.store_folders WHERE parent_id = v_root.id AND trashed_at IS NULL AND kind = 'custom' AND template_slug = c_archive;
    IF v_n > 1 THEN v_problem := format('%s "Previous names" folders under the top folder (expected at most one)', v_n); END IF;
  END IF;
  IF v_problem IS NULL THEN
    -- an upload that started before the change would finish into the old (now archived) folder
    SELECT count(*) INTO v_n FROM public.store_upload_intents WHERE owner_id = p_owner_id AND consumed_at IS NULL AND expires_at > now();
    IF v_n > 0 THEN v_problem := format('%s upload(s) to this storage are still in progress — try again in a few minutes', v_n); END IF;
  END IF;
  IF v_problem IS NULL AND to_regclass('public.store_import_runs') IS NOT NULL THEN
    -- the company's move from Drive into the storage is still running (touched in the last 10 minutes): its next batch would file into the archive
    SELECT count(*) INTO v_n FROM public.store_import_runs
     WHERE account_id = v_owner.account_id AND status IN ('scanning', 'moving', 'undoing') AND updated_at > now() - interval '10 minutes';
    IF v_n > 0 THEN v_problem := 'the move of this company''s documents into the new storage is still running — try again when it has finished'; END IF;
  END IF;

  IF v_problem IS NOT NULL THEN
    IF p_dry_run THEN
      RETURN jsonb_build_object('status', 'dry_run', 'ok', false, 'problem', v_problem, 'owner_id', p_owner_id, 'dry_run', true);
    END IF;
    RAISE EXCEPTION 'store: name change refused — %', v_problem USING ERRCODE = 'check_violation';
  END IF;

  -- the plan
  SELECT id INTO v_arch_root FROM public.store_folders
   WHERE parent_id = v_root.id AND trashed_at IS NULL AND kind = 'custom' AND template_slug = c_archive;
  IF v_arch_root IS NULL THEN
    v_arch_root_name := public.store_free_name(v_root.id, 'Previous names', true);
    v_arch_child_name := v_old_root;
  ELSE
    SELECT name INTO v_arch_root_name FROM public.store_folders WHERE id = v_arch_root;
    v_arch_child_name := public.store_free_name(v_arch_root, v_old_root, true);       -- A -> B -> A -> C: the second "A" becomes "A (2)"
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object('status', 'dry_run', 'ok', true, 'owner_id', p_owner_id, 'dry_run', true,
      'old_root_name', v_old_root, 'new_root_name', v_new_root, 'archive_root_name', v_arch_root_name,
      'archive_root_exists', v_arch_root IS NOT NULL, 'archive_child_name', v_arch_child_name,
      'would_move', to_jsonb(c_moved), 'would_create', to_jsonb(c_moved), 'left_in_place', jsonb_build_array('contacts'));
  END IF;

  -- 1. the archive containers (locked: they carry a template slug)
  IF v_arch_root IS NULL THEN
    INSERT INTO public.store_folders (owner_id, parent_id, kind, template_slug, name, created_by)
    VALUES (p_owner_id, v_root.id, 'custom', c_archive, v_arch_root_name, p_actor) RETURNING id INTO v_arch_root;
    v_arch_root_created := true;
  END IF;
  INSERT INTO public.store_folders (owner_id, parent_id, kind, template_slug, name, created_by)
  VALUES (p_owner_id, v_arch_root, 'custom', c_archive, v_arch_child_name, p_actor) RETURNING id INTO v_arch_child;

  -- 2. move the four content folders, whole (same owner, new parent): their sub-folders and files go with them untouched
  FOREACH v_kind IN ARRAY c_moved LOOP
    UPDATE public.store_folders SET parent_id = v_arch_child
     WHERE owner_id = p_owner_id AND parent_id = v_root.id AND trashed_at IS NULL AND kind = v_kind
    RETURNING id INTO STRICT v_id;
    v_moved := v_moved || jsonb_build_object(v_kind, v_id);
  END LOOP;
  SELECT id INTO STRICT v_contacts FROM public.store_folders WHERE parent_id = v_root.id AND trashed_at IS NULL AND kind = 'contacts';

  -- 3. the top folder takes the new name (logged by store_rename_root)
  PERFORM public.store_rename_root(p_owner_id, v_new_root, p_actor);

  -- 4. the fresh standard folders (the template creates exactly the ones now missing)
  PERFORM public.store_apply_template(p_owner_id, c_template, v_new_root, p_actor);
  FOREACH v_kind IN ARRAY c_moved LOOP
    SELECT count(*) INTO v_n FROM public.store_folders WHERE parent_id = v_root.id AND trashed_at IS NULL AND kind = v_kind;
    IF v_n <> 1 THEN RAISE EXCEPTION 'store: name change failed — expected one new "%" folder, found %', v_kind, v_n; END IF;
    SELECT id INTO v_id FROM public.store_folders WHERE parent_id = v_root.id AND trashed_at IS NULL AND kind = v_kind;
    v_created := v_created || jsonb_build_object(v_kind, v_id);
  END LOOP;

  -- 5. the marker + the record of exactly what was done (the undo reads these ids)
  v_details := jsonb_build_object(
    'change_id', p_change_id, 'old_name', p_old_name, 'new_name', p_new_name,
    'old_root_name', v_old_root, 'new_root_name', v_new_root, 'root_folder_id', v_root.id,
    'archive_root_id', v_arch_root, 'archive_root_created', v_arch_root_created,
    'archive_child_id', v_arch_child, 'archive_child_name', v_arch_child_name,
    'moved', v_moved, 'created', v_created, 'left_in_place', jsonb_build_object('contacts', v_contacts));
  INSERT INTO public.store_events (event, actor, owner_id, folder_id, name_snapshot, reason, details)
  VALUES ('name_change_applied', p_actor, p_owner_id, v_arch_child, v_new_root, 'Company name changed', v_details);

  RETURN jsonb_build_object('status', 'applied', 'owner_id', p_owner_id, 'dry_run', false) || v_details;
END $$;

-- ─────────────────────────────────────────────────────────────── the bounded undo
CREATE OR REPLACE FUNCTION public.store_undo_name_change(
  p_owner_id uuid, p_change_id uuid, p_actor uuid DEFAULT NULL, p_dry_run boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_owner     record;
  v_last      record;
  v_top       record;
  v_d         jsonb;
  v_problem   text;
  v_root_id   uuid;
  v_arch_child uuid;
  v_arch_root uuid;
  v_arch_root_created boolean;
  v_moved     uuid[];
  v_created   uuid[];
  v_old_root  text;
  v_n         integer;
  v_k         text;
  v_id        uuid;
  v_deleted   jsonb := '[]'::jsonb;
BEGIN
  IF p_owner_id IS NULL OR p_change_id IS NULL THEN
    RAISE EXCEPTION 'store: an undo needs the storage and the change id' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT p_dry_run THEN PERFORM public.store_lock_owner(p_owner_id); END IF;

  SELECT * INTO v_owner FROM public.store_owners WHERE id = p_owner_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_storage', 'owner_id', p_owner_id, 'dry_run', p_dry_run); END IF;
  IF v_owner.kind <> 'company' THEN RETURN jsonb_build_object('status', 'skipped', 'reason', 'not_company', 'owner_id', p_owner_id, 'dry_run', p_dry_run); END IF;
  IF v_owner.study_only THEN RETURN jsonb_build_object('status', 'skipped', 'reason', 'study_only', 'owner_id', p_owner_id, 'dry_run', p_dry_run); END IF;

  -- this change was already undone (latest word on it is 'undone')
  SELECT e.id, e.event INTO v_last FROM public.store_events e
   WHERE e.owner_id = p_owner_id AND e.event IN ('name_change_applied', 'name_change_undone') AND e.details->>'change_id' = p_change_id::text
   ORDER BY e.id DESC LIMIT 1;
  IF FOUND AND v_last.event = 'name_change_undone' THEN
    RETURN jsonb_build_object('status', 'already_undone', 'owner_id', p_owner_id, 'change_id', p_change_id, 'dry_run', p_dry_run);
  END IF;

  -- the LATEST change that has not been undone since
  SELECT e.id, e.details INTO v_top FROM public.store_events e
   WHERE e.owner_id = p_owner_id AND e.event = 'name_change_applied'
     AND NOT EXISTS (SELECT 1 FROM public.store_events u
                      WHERE u.owner_id = e.owner_id AND u.event = 'name_change_undone'
                        AND u.details->>'change_id' = e.details->>'change_id' AND u.id > e.id)
   ORDER BY e.id DESC LIMIT 1;
  IF NOT FOUND THEN
    v_problem := 'this storage has no name change to undo';
  ELSIF v_top.details->>'change_id' IS DISTINCT FROM p_change_id::text THEN
    v_problem := format('only the latest name change can be undone (this storage''s latest is %s)', v_top.details->>'change_id');
  ELSE
    v_d := v_top.details;
    v_root_id := (v_d->>'root_folder_id')::uuid;
    v_arch_child := (v_d->>'archive_child_id')::uuid;
    v_arch_root := (v_d->>'archive_root_id')::uuid;
    v_arch_root_created := coalesce((v_d->>'archive_root_created')::boolean, false);
    v_old_root := v_d->>'old_root_name';
    v_moved := ARRAY(SELECT value::uuid FROM jsonb_each_text(v_d->'moved'));
    v_created := ARRAY(SELECT value::uuid FROM jsonb_each_text(v_d->'created'));
    IF v_root_id IS NULL OR v_arch_child IS NULL OR v_old_root IS NULL OR cardinality(v_moved) <> 4 OR cardinality(v_created) <> 4 THEN
      v_problem := 'the record of that name change is incomplete';
    END IF;
  END IF;

  IF v_problem IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.store_folders WHERE id = v_root_id AND owner_id = p_owner_id AND parent_id IS NULL AND trashed_at IS NULL) THEN
      v_problem := 'the top folder is not the one the name change used';
    END IF;
  END IF;
  IF v_problem IS NULL THEN
    SELECT count(*) INTO v_n FROM public.store_folders WHERE id = ANY (v_moved) AND parent_id = v_arch_child AND trashed_at IS NULL;
    IF v_n <> 4 THEN v_problem := 'the old folders are no longer all inside the archive'; END IF;
  END IF;
  IF v_problem IS NULL THEN
    SELECT count(*) INTO v_n FROM public.store_folders WHERE id = ANY (v_created) AND parent_id = v_root_id AND trashed_at IS NULL;
    IF v_n <> 4 THEN v_problem := 'the new folders are no longer all under the top folder'; END IF;
  END IF;
  IF v_problem IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.store_folders WHERE parent_id = ANY (v_created))
       OR EXISTS (SELECT 1 FROM public.store_files WHERE folder_id = ANY (v_created))
       OR EXISTS (SELECT 1 FROM public.store_upload_intents WHERE folder_id = ANY (v_created)) THEN
      v_problem := 'the new folders already hold files or folders — the name change can no longer be undone';
    END IF;
  END IF;
  IF v_problem IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.store_folders WHERE parent_id = v_arch_child AND NOT (id = ANY (v_moved)))
       OR EXISTS (SELECT 1 FROM public.store_files WHERE folder_id = v_arch_child) THEN
      v_problem := 'something else was added to the archive — the name change can no longer be undone';
    END IF;
  END IF;

  IF v_problem IS NOT NULL THEN
    IF p_dry_run THEN RETURN jsonb_build_object('status', 'dry_run', 'ok', false, 'problem', v_problem, 'owner_id', p_owner_id, 'dry_run', true); END IF;
    RAISE EXCEPTION 'store: undo refused — %', v_problem USING ERRCODE = 'check_violation';
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object('status', 'dry_run', 'ok', true, 'owner_id', p_owner_id, 'dry_run', true,
      'would_delete', to_jsonb(v_created), 'would_move_back', to_jsonb(v_moved), 'would_rename_root_to', v_old_root);
  END IF;

  -- 1. the new (empty) fixed folders go — only these exact ids; template folders cannot be trashed, so this is a privileged delete
  PERFORM set_config('store.privileged', 'on', true);
  FOREACH v_id IN ARRAY v_created LOOP
    DELETE FROM public.store_folders WHERE id = v_id AND owner_id = p_owner_id;
    v_deleted := v_deleted || to_jsonb(v_id);
  END LOOP;
  PERFORM set_config('store.privileged', 'off', true);

  -- 2. the old folders go back under the top folder
  UPDATE public.store_folders SET parent_id = v_root_id WHERE id = ANY (v_moved) AND owner_id = p_owner_id;

  -- 3. the (now empty) archive of this change goes; the "Previous names" container only if this change made it and nothing else is in it
  PERFORM set_config('store.privileged', 'on', true);
  DELETE FROM public.store_folders WHERE id = v_arch_child AND owner_id = p_owner_id;
  v_deleted := v_deleted || to_jsonb(v_arch_child);
  IF v_arch_root_created AND v_arch_root IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.store_folders WHERE parent_id = v_arch_root)
     AND NOT EXISTS (SELECT 1 FROM public.store_files WHERE folder_id = v_arch_root) THEN
    DELETE FROM public.store_folders WHERE id = v_arch_root AND owner_id = p_owner_id;
    v_deleted := v_deleted || to_jsonb(v_arch_root);
  END IF;
  PERFORM set_config('store.privileged', 'off', true);

  -- 4. the top folder gets its old name back
  PERFORM public.store_rename_root(p_owner_id, v_old_root, p_actor);

  INSERT INTO public.store_events (event, actor, owner_id, folder_id, name_snapshot, reason, details)
  VALUES ('name_change_undone', p_actor, p_owner_id, v_root_id, v_old_root, 'Company name change undone',
          jsonb_build_object('change_id', p_change_id, 'restored_root_name', v_old_root, 'deleted_folder_ids', v_deleted, 'moved_back', v_d->'moved'));

  RETURN jsonb_build_object('status', 'undone', 'owner_id', p_owner_id, 'change_id', p_change_id, 'dry_run', false,
                            'restored_root_name', v_old_root, 'deleted_folder_ids', v_deleted, 'moved_back', v_d->'moved');
END $$;

-- ─────────────────────────────────────────────────────────────── the account wrappers: account + storage in ONE transaction
CREATE OR REPLACE FUNCTION public.store_apply_name_change_for_account(
  p_account_id uuid, p_change_id uuid, p_new_name text, p_expected_old_name text,
  p_actor uuid DEFAULT NULL, p_dry_run boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_acct    record;
  v_new     text := btrim(regexp_replace(coalesce(p_new_name, ''), '[[:space:]]+', ' ', 'g'));
  v_hit     jsonb;
  v_owner   uuid;
  v_storage jsonb;
  v_entry   jsonb;
BEGIN
  IF p_account_id IS NULL OR p_change_id IS NULL THEN
    RAISE EXCEPTION 'store: a name change needs the company and a change id' USING ERRCODE = 'check_violation';
  END IF;
  IF v_new = '' THEN RAISE EXCEPTION 'store: a name change needs the new name' USING ERRCODE = 'check_violation'; END IF;
  IF p_expected_old_name IS NULL OR btrim(p_expected_old_name) = '' THEN
    RAISE EXCEPTION 'store: a name change needs the company''s current name' USING ERRCODE = 'check_violation';
  END IF;
  IF public.store_name_key(v_new) = public.store_name_key(p_expected_old_name) THEN
    RAISE EXCEPTION 'store: name change refused — the new name differs only by capital letters or spacing; that is a correction, not a name change' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, company_name, previous_name, name_history INTO v_acct FROM public.accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store: company % not found', p_account_id USING ERRCODE = 'check_violation'; END IF;

  -- a retry / second click: the history already holds this change and it has not been undone since
  SELECT t.e INTO v_hit FROM jsonb_array_elements(v_acct.name_history) WITH ORDINALITY AS t(e, i)
   WHERE t.e->>'type' = 'change' AND t.e->>'change_id' = p_change_id::text
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_acct.name_history) WITH ORDINALITY AS u(x, j)
                      WHERE u.j > t.i AND u.x->>'type' = 'undo' AND u.x->>'change_id' = p_change_id::text)
   ORDER BY t.i DESC LIMIT 1;
  IF v_hit IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_applied', 'account_id', p_account_id, 'old_name', v_hit->>'old_name',
                              'new_name', v_hit->>'new_name', 'storage', v_hit->'storage', 'dry_run', p_dry_run);
  END IF;

  -- compare-and-set: the name must still be the one the caller saw
  IF v_acct.company_name IS DISTINCT FROM p_expected_old_name THEN
    RETURN jsonb_build_object('status', 'conflict', 'account_id', p_account_id, 'current_name', v_acct.company_name, 'dry_run', p_dry_run);
  END IF;

  SELECT id INTO v_owner FROM public.store_owners WHERE account_id = p_account_id;
  IF v_owner IS NULL THEN
    v_storage := jsonb_build_object('status', 'skipped', 'reason', 'no_storage');      -- a company still on Drive: the name changes, nothing moves
  ELSE
    v_storage := public.store_apply_name_change(v_owner, p_change_id, p_expected_old_name, v_new, p_actor, p_dry_run);
  END IF;
  IF p_dry_run THEN
    RETURN jsonb_build_object('status', 'dry_run', 'account_id', p_account_id, 'old_name', p_expected_old_name, 'new_name', v_new, 'storage', v_storage, 'dry_run', true);
  END IF;

  v_entry := jsonb_build_object('type', 'change', 'change_id', p_change_id, 'at', to_jsonb(now()), 'by', p_actor,
    'old_name', p_expected_old_name, 'new_name', v_new, 'previous_name_before', v_acct.previous_name, 'storage', v_storage);
  UPDATE public.accounts
     SET company_name = v_new, previous_name = p_expected_old_name,
         name_history = name_history || jsonb_build_array(v_entry), updated_at = now()
   WHERE id = p_account_id;

  RETURN jsonb_build_object('status', 'applied', 'account_id', p_account_id, 'old_name', p_expected_old_name, 'new_name', v_new, 'storage', v_storage, 'dry_run', false);
END $$;

CREATE OR REPLACE FUNCTION public.store_undo_name_change_for_account(
  p_account_id uuid, p_change_id uuid, p_actor uuid DEFAULT NULL, p_dry_run boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_acct    record;
  v_top     jsonb;
  v_mine    jsonb;
  v_owner   uuid;
  v_storage jsonb;
BEGIN
  IF p_account_id IS NULL OR p_change_id IS NULL THEN
    RAISE EXCEPTION 'store: an undo needs the company and the change id' USING ERRCODE = 'check_violation';
  END IF;
  SELECT id, company_name, previous_name, name_history INTO v_acct FROM public.accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store: company % not found', p_account_id USING ERRCODE = 'check_violation'; END IF;

  -- this change: applied and not undone since? (otherwise: undone already, or never happened)
  SELECT t.e INTO v_mine FROM jsonb_array_elements(v_acct.name_history) WITH ORDINALITY AS t(e, i)
   WHERE t.e->>'type' = 'change' AND t.e->>'change_id' = p_change_id::text
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_acct.name_history) WITH ORDINALITY AS u(x, j)
                      WHERE u.j > t.i AND u.x->>'type' = 'undo' AND u.x->>'change_id' = p_change_id::text)
   ORDER BY t.i DESC LIMIT 1;
  IF v_mine IS NULL THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_acct.name_history) AS t(e) WHERE t.e->>'type' = 'undo' AND t.e->>'change_id' = p_change_id::text) THEN
      RETURN jsonb_build_object('status', 'already_undone', 'account_id', p_account_id, 'change_id', p_change_id, 'dry_run', p_dry_run);
    END IF;
    RAISE EXCEPTION 'store: undo refused — this company has no such name change to undo' USING ERRCODE = 'check_violation';
  END IF;
  -- bounded: only the LATEST change that has not been undone since
  SELECT t.e INTO v_top FROM jsonb_array_elements(v_acct.name_history) WITH ORDINALITY AS t(e, i)
   WHERE t.e->>'type' = 'change'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_acct.name_history) WITH ORDINALITY AS u(x, j)
                      WHERE u.j > t.i AND u.x->>'type' = 'undo' AND u.x->>'change_id' = t.e->>'change_id')
   ORDER BY t.i DESC LIMIT 1;
  IF v_top->>'change_id' IS DISTINCT FROM p_change_id::text THEN
    RAISE EXCEPTION 'store: undo refused — only the latest name change can be undone (this company''s latest is %)', v_top->>'change_id' USING ERRCODE = 'check_violation';
  END IF;
  IF v_acct.company_name IS DISTINCT FROM v_top->>'new_name' THEN
    RETURN jsonb_build_object('status', 'conflict', 'account_id', p_account_id, 'current_name', v_acct.company_name, 'dry_run', p_dry_run);
  END IF;

  IF coalesce(v_top->'storage'->>'status', '') IN ('applied', 'already_applied') THEN
    SELECT id INTO v_owner FROM public.store_owners WHERE account_id = p_account_id;
    IF v_owner IS NULL THEN RAISE EXCEPTION 'store: undo refused — the storage that was changed no longer exists' USING ERRCODE = 'check_violation'; END IF;
    v_storage := public.store_undo_name_change(v_owner, p_change_id, p_actor, p_dry_run);
  ELSE
    v_storage := jsonb_build_object('status', 'skipped', 'reason', 'storage_was_not_changed');
  END IF;
  IF p_dry_run THEN
    RETURN jsonb_build_object('status', 'dry_run', 'account_id', p_account_id, 'restores_name', v_top->>'old_name', 'storage', v_storage, 'dry_run', true);
  END IF;

  UPDATE public.accounts
     SET company_name = v_top->>'old_name', previous_name = v_top->>'previous_name_before',
         name_history = name_history || jsonb_build_array(jsonb_build_object(
           'type', 'undo', 'change_id', p_change_id, 'at', to_jsonb(now()), 'by', p_actor,
           'restored_name', v_top->>'old_name', 'undone_name', v_top->>'new_name', 'storage', v_storage)),
         updated_at = now()
   WHERE id = p_account_id;

  RETURN jsonb_build_object('status', 'undone', 'account_id', p_account_id, 'change_id', p_change_id,
                            'restored_name', v_top->>'old_name', 'storage', v_storage, 'dry_run', false);
END $$;

-- ─────────────────────────────────────────────────────────────── access: the service role only (like every store_* function)
REVOKE ALL ON FUNCTION public.store_safe_folder_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_apply_name_change(uuid, uuid, text, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_undo_name_change(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_apply_name_change_for_account(uuid, uuid, text, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_undo_name_change_for_account(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────── verification (raises = nothing changes)
DO $$
DECLARE
  f text;
  v_r jsonb;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.store_safe_folder_name(text)',
    'public.store_apply_name_change(uuid,uuid,text,text,uuid,boolean)',
    'public.store_undo_name_change(uuid,uuid,uuid,boolean)',
    'public.store_apply_name_change_for_account(uuid,uuid,text,text,uuid,boolean)',
    'public.store_undo_name_change_for_account(uuid,uuid,uuid,boolean)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'verify: % was not created', f; END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'verify: % can be called by the public web roles', f;
    END IF;
  END LOOP;
  IF public.store_safe_folder_name(E'  A/B \\ C\tLLC  ') <> 'A-B - C-LLC' THEN
    RAISE EXCEPTION 'verify: the folder-safe name rule gave "%"', public.store_safe_folder_name(E'  A/B \\ C\tLLC  ');
  END IF;
  -- a dry run on a storage that does not exist changes nothing and answers "skipped"
  v_r := public.store_apply_name_change('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'Old LLC', 'New LLC', NULL, true);
  IF v_r->>'status' <> 'skipped' THEN RAISE EXCEPTION 'verify: dry run on a missing storage answered %', v_r; END IF;
END $$;

COMMIT;

-- final check (one row): every company storage, asked "could you change name today?" with a DRY RUN (writes nothing, takes no lock)
SELECT
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN
     ('store_safe_folder_name', 'store_apply_name_change', 'store_undo_name_change', 'store_apply_name_change_for_account', 'store_undo_name_change_for_account')) AS functions_created,
  count(*) AS company_storages,
  count(*) FILTER (WHERE d.r->>'status' = 'dry_run' AND d.r->>'ok' = 'true') AS could_change_name_today,
  count(*) FILTER (WHERE d.r->>'status' = 'dry_run' AND d.r->>'ok' = 'false') AS would_be_refused,
  count(*) FILTER (WHERE d.r->>'status' = 'skipped') AS would_be_skipped,
  string_agg(DISTINCT d.r->>'problem', ' | ') FILTER (WHERE d.r->>'ok' = 'false') AS refusal_reasons
FROM (
  SELECT public.store_apply_name_change(o.id, gen_random_uuid(), 'x', 'Zz Dry Run Name', NULL, true) AS r
    FROM public.store_owners o WHERE o.kind = 'company'
) d;
