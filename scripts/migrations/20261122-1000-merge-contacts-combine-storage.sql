BEGIN;

-- merge_contacts(): when BOTH contacts already have their own CRM Storage, COMBINE the two storages inside the merge
-- (dev job 938af003, slice 2). Before this, the app refused such a merge ("ask for them to be combined first").
--
-- What the combine does (all in the SAME transaction as the merge, so a failure leaves nothing half-moved):
--  * every file and folder of the removed contact's storage moves into the kept contact's storage, keeping the same file
--    records (versions, shares, links, people and backup stay attached);
--  * a folder with the same name on both sides is merged; a folder only the removed contact has moves over as it is;
--  * a file whose name is already taken in that folder is KEPT and renamed ("name (2).ext"): nothing is overwritten and
--    nothing is dropped, even when the two files are identical (a flag in the plan says so; removing a duplicate is a
--    human choice made afterwards);
--  * the removed contact's top folder, empty folders and storage record are removed only after everything has moved;
--  * the plan (what moved, what was renamed, which folders merged) is written into contact_merge_log.snapshot.storage_combined.
--
-- Cases it cannot handle stay REFUSED with a plain message (store_combine_blocker): a study copy of Google Drive on either
-- side, or files / folders in the TRASH or already deleted on the removed contact's side (the store refuses to move trashed
-- items between owners; restore them first).
--
-- store_combine_plan() runs the very same code inside a sub-transaction that is always rolled back, so the preview in the
-- merge window shows exactly what the merge would do and changes nothing.
-- Rollback: scripts/migrations/20261122-1000-merge-contacts-combine-storage.UNDO.sql

-- ── 1. Can these two storages be combined? NULL = yes, otherwise the reason in plain words ───────────────────────
CREATE OR REPLACE FUNCTION public.store_combine_blocker(p_from uuid, p_to uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $fn$
DECLARE
  o_from record;
  o_to record;
  v_n bigint;
BEGIN
  SELECT * INTO o_from FROM public.store_owners WHERE id = p_from;
  IF NOT FOUND THEN RETURN 'One of the two storages was not found.'; END IF;
  SELECT * INTO o_to FROM public.store_owners WHERE id = p_to;
  IF NOT FOUND THEN RETURN 'One of the two storages was not found.'; END IF;
  IF p_from = p_to THEN RETURN 'A storage cannot be combined with itself.'; END IF;
  IF o_from.kind <> 'person' OR o_to.kind <> 'person' THEN RETURN 'Only the storages of two people can be combined.'; END IF;
  IF o_from.study_only OR o_to.study_only THEN
    RETURN 'Both contacts have files in the new CRM storage, and at least one of them was created by a Google Drive study copy (it stays even after the copy is removed). Those two storages cannot be combined automatically.';
  END IF;
  SELECT count(*) INTO v_n FROM public.store_files WHERE owner_id = p_from AND state <> 'live';
  IF v_n > 0 THEN
    RETURN format('The merged-away contact has %s file(s) in the trash or already deleted. The storage will not move trashed files — restore them from the trash (or remove them for good), then merge again.', v_n);
  END IF;
  SELECT count(*) INTO v_n FROM public.store_folders WHERE owner_id = p_from AND trashed_at IS NOT NULL;
  IF v_n > 0 THEN
    RETURN format('The merged-away contact has %s folder(s) in the trash. The storage will not move trashed folders — restore them from the trash, then merge again.', v_n);
  END IF;
  RETURN NULL;
END
$fn$;

-- ── 2. Combine: everything of p_from moves into p_to, then p_from's storage record goes ─────────────────────────
-- p_dry = true does all the work and rolls it back (the plan is still returned).
CREATE OR REPLACE FUNCTION public.store_combine_owners(p_from uuid, p_to uuid, p_actor uuid DEFAULT NULL, p_dry boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $fn$
DECLARE
  v_block text;
  v_root_l uuid;
  v_root_w uuid;
  v_q_l uuid[];                  -- queue of folder pairs still to combine (removed side)
  v_q_w uuid[];                  -- ... and the kept side
  v_q_p text[];                  -- ... and the path shown to people
  v_i int := 1;
  v_l uuid;
  v_w uuid;
  v_path text;
  f record;
  c record;
  m record;
  v_clash record;
  v_new text;
  v_same boolean;
  v_n int;
  v_moved_ids uuid[] := '{}';
  v_subtree_files int := 0;
  v_renamed jsonb := '[]'::jsonb;
  v_merged jsonb := '[]'::jsonb;
  v_moved_folders jsonb := '[]'::jsonb;
  v_removed int := 0;
  v_plan jsonb;
BEGIN
  v_block := public.store_combine_blocker(p_from, p_to);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION 'store_combine: %', v_block; END IF;

  PERFORM public.store_lock_owner(least(p_from, p_to));
  PERFORM public.store_lock_owner(greatest(p_from, p_to));

  SELECT id INTO v_root_l FROM public.store_folders WHERE owner_id = p_from AND parent_id IS NULL;
  SELECT id INTO v_root_w FROM public.store_folders WHERE owner_id = p_to AND parent_id IS NULL;
  IF v_root_l IS NULL OR v_root_w IS NULL THEN RAISE EXCEPTION 'store_combine: a storage has no top folder'; END IF;
  v_q_l := ARRAY[v_root_l];
  v_q_w := ARRAY[v_root_w];
  v_q_p := ARRAY[''];

  BEGIN   -- sub-transaction: a dry run raises at the end and everything above is rolled back
    PERFORM set_config('store.privileged', 'on', true);

    WHILE v_i <= array_length(v_q_l, 1) LOOP
      v_l := v_q_l[v_i]; v_w := v_q_w[v_i]; v_path := v_q_p[v_i];
      v_i := v_i + 1;

      -- files of this folder (every file is live: the blocker refused trashed and deleted ones)
      FOR f IN SELECT id, name, current_version_id FROM public.store_files WHERE folder_id = v_l ORDER BY name_key, id LOOP
        v_new := f.name;
        SELECT id, current_version_id INTO v_clash FROM public.store_files
         WHERE folder_id = v_w AND state = 'live' AND name_key = public.store_name_key(f.name);
        IF v_clash.id IS NOT NULL THEN
          v_new := public.store_free_name(v_w, f.name, false);
          SELECT (a.sha256 = b.sha256) INTO v_same
            FROM public.store_file_versions a, public.store_file_versions b
           WHERE a.id = f.current_version_id AND b.id = v_clash.current_version_id;
          v_renamed := v_renamed || jsonb_build_object('file_id', f.id, 'folder', CASE WHEN v_path = '' THEN '/' ELSE v_path END,
                                                       'name', f.name, 'new_name', v_new, 'same_content', coalesce(v_same, false));
        END IF;
        PERFORM set_config('store.privileged', 'on', true);
        UPDATE public.store_files SET owner_id = p_to, folder_id = v_w, name = v_new WHERE id = f.id;
        v_moved_ids := v_moved_ids || f.id;
      END LOOP;

      -- sub-folders: the same name on the kept side -> combined too; otherwise the whole branch moves as it is
      FOR c IN SELECT id, name, kind FROM public.store_folders WHERE parent_id = v_l ORDER BY name_key, id LOOP
        SELECT id, kind INTO m FROM public.store_folders
         WHERE owner_id = p_to AND parent_id = v_w AND trashed_at IS NULL AND name_key = public.store_name_key(c.name);
        IF m.id IS NOT NULL AND m.kind = c.kind THEN
          v_q_l := v_q_l || c.id; v_q_w := v_q_w || m.id; v_q_p := v_q_p || (v_path || '/' || c.name);
          v_merged := v_merged || jsonb_build_object('folder', v_path || '/' || c.name);
        ELSE
          v_new := c.name;
          PERFORM set_config('store.privileged', 'on', true);
          IF m.id IS NOT NULL THEN            -- same name but a different kind of folder: keep both, rename the incoming one
            v_new := public.store_free_name(v_w, c.name, true);
            UPDATE public.store_folders SET name = v_new WHERE id = c.id;
          END IF;
          WITH RECURSIVE sub(id) AS (
            SELECT c.id UNION ALL SELECT x.id FROM public.store_folders x JOIN sub ON x.parent_id = sub.id)
          SELECT count(*) INTO v_n FROM public.store_files WHERE folder_id IN (SELECT id FROM sub);
          v_subtree_files := v_subtree_files + v_n;
          v_moved_folders := v_moved_folders || jsonb_build_object('folder', v_path || '/' || c.name, 'new_name', v_new, 'files', v_n);
          PERFORM public.store_rehome_subtree(c.id, p_to, v_w, p_actor, 'Two contacts were merged: their storages were combined');
        END IF;
      END LOOP;
    END LOOP;

    -- links / people of the files that moved one by one (the branches moved above did this themselves)
    PERFORM set_config('store.privileged', 'on', true);
    IF coalesce(array_length(v_moved_ids, 1), 0) > 0 THEN
      PERFORM public.store_rehome_reconcile(v_moved_ids, p_from, p_to, p_actor);
    END IF;

    -- the combined folders of the removed side are empty now: remove them, deepest first, only if really empty
    FOR v_i IN REVERSE array_length(v_q_l, 1)..1 LOOP
      PERFORM set_config('store.privileged', 'on', true);
      IF EXISTS (SELECT 1 FROM public.store_files WHERE folder_id = v_q_l[v_i])
         OR EXISTS (SELECT 1 FROM public.store_folders WHERE parent_id = v_q_l[v_i]) THEN
        RAISE EXCEPTION 'store_combine: a folder of the removed storage is not empty after the move (%)', v_q_l[v_i];
      END IF;
      UPDATE public.store_upload_intents SET folder_id = v_q_w[v_i] WHERE folder_id = v_q_l[v_i];
      DELETE FROM public.store_folders WHERE id = v_q_l[v_i];
      v_removed := v_removed + 1;
    END LOOP;

    UPDATE public.store_upload_intents SET owner_id = p_to WHERE owner_id = p_from;
    UPDATE public.store_import_runs SET owner_id = p_to WHERE owner_id = p_from;
    DELETE FROM public.store_backup_state WHERE owner_id = p_from;   -- the kept storage is backed up on its own; its changes are logged

    v_plan := jsonb_build_object(
      'combined', true, 'from_owner', p_from, 'to_owner', p_to,
      'files_moved', coalesce(array_length(v_moved_ids, 1), 0) + v_subtree_files,
      'files_renamed', v_renamed, 'folders_merged', v_merged, 'folders_moved', v_moved_folders,
      'folders_removed', v_removed, 'file_ids', to_jsonb(v_moved_ids));

    IF NOT p_dry THEN
      INSERT INTO public.store_events (event, actor, owner_id, reason, details)
      VALUES ('combined', p_actor, p_to, 'Two contacts were merged: their storages were combined',
              jsonb_build_object('from_owner', p_from, 'files', coalesce(array_length(v_moved_ids, 1), 0) + v_subtree_files,
                                 'renamed', jsonb_array_length(v_renamed)));
    END IF;
    DELETE FROM public.store_owners WHERE id = p_from;
    PERFORM set_config('store.privileged', 'off', true);

    IF p_dry THEN
      RAISE EXCEPTION USING ERRCODE = 'X0DRY', MESSAGE = v_plan::text;
    END IF;
    RETURN v_plan;
  EXCEPTION WHEN SQLSTATE 'X0DRY' THEN
    RETURN SQLERRM::jsonb;
  END;
END
$fn$;

-- ── 3. The plan, for the merge window: read-only (a dry run that is rolled back) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.store_combine_plan(p_loser_contact uuid, p_winner_contact uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $fn$
DECLARE
  v_lo uuid;
  v_wo uuid;
  v_block text;
BEGIN
  SELECT id INTO v_lo FROM public.store_owners WHERE contact_id = p_loser_contact AND kind = 'person';
  SELECT id INTO v_wo FROM public.store_owners WHERE contact_id = p_winner_contact AND kind = 'person';
  IF v_lo IS NULL OR v_wo IS NULL THEN RETURN jsonb_build_object('combined', false); END IF;
  v_block := public.store_combine_blocker(v_lo, v_wo);
  IF v_block IS NOT NULL THEN RETURN jsonb_build_object('combined', false, 'blocker', v_block); END IF;
  RETURN public.store_combine_owners(v_lo, v_wo, NULL, true);
END
$fn$;

REVOKE ALL ON FUNCTION public.store_combine_blocker(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_combine_owners(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_combine_plan(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_combine_blocker(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_combine_owners(uuid, uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_combine_plan(uuid, uuid) TO service_role;


-- ── 4. merge_contacts(): combine the two storages when both contacts have one ────────────────────────────────
CREATE OR REPLACE FUNCTION public.merge_contacts(
  p_loser uuid,
  p_winner uuid,
  p_merged_by text DEFAULT NULL::text,
  p_field_choices jsonb DEFAULT '{}'::jsonb,
  p_document_ids uuid[] DEFAULT '{}'::uuid[]
)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_loser     contacts%ROWTYPE;
  v_winner    contacts%ROWTYPE;
  v_fk        record;
  v_count     bigint;
  v_total     bigint := 0;
  v_reassign  jsonb := '{}'::jsonb;
  v_deleted_links jsonb := '[]'::jsonb;
  v_new_alts  text[];
  -- personal details that may be copied
  c_plain     text[] := ARRAY['phone','phone_2','phone_3','phone_4','email_2','citizenship','residency','gender'];
  c_identity  text[] := ARRAY['date_of_birth','passport_number','passport_expiry_date','itin_number','itin','itin_issue_date'];
  -- the address is ONE block (chosen with the key address_line1): a mixed address is never built
  c_addr      text[] := ARRAY['address_line1','address_city','address_state','address_zip','address_country'];
  v_l_has     boolean;
  v_w_has     boolean;
  v_l_norm    text;
  v_w_norm    text;
  v_dep       text[];
  v_field     text;
  v_lj        jsonb;
  v_wj        jsonb;
  v_lv        text;
  v_wv        text;
  v_choice    text;
  v_copied    jsonb := '{}'::jsonb;
  v_from_loser jsonb := '{}'::jsonb;
  v_kept      jsonb := '{}'::jsonb;
  v_unresolved text[] := '{}';
  v_bad_choice text;
  v_doc_snap  jsonb := '[]'::jsonb;
  v_doc_ok    int;
  -- both contacts already have their own storage: combine the two inside this merge
  v_lo        uuid;
  v_wo        uuid;
  v_store_both boolean := false;
  v_block     text;
  v_combined  jsonb := NULL;
BEGIN
  IF p_loser = p_winner THEN
    RAISE EXCEPTION 'merge_contacts: loser and winner must differ';
  END IF;

  -- lock both rows, always in id order (no deadlock when two merges overlap)
  PERFORM 1 FROM contacts WHERE id IN (p_loser, p_winner) ORDER BY id FOR UPDATE;

  SELECT * INTO v_loser FROM contacts WHERE id = p_loser;
  IF NOT FOUND THEN RAISE EXCEPTION 'merge_contacts: loser % not found', p_loser; END IF;
  SELECT * INTO v_winner FROM contacts WHERE id = p_winner;
  IF NOT FOUND THEN RAISE EXCEPTION 'merge_contacts: winner % not found', p_winner; END IF;
  IF v_loser.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'merge_contacts: loser % already merged into %', p_loser, v_loser.merged_into;
  END IF;
  IF v_winner.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'merge_contacts: winner % is itself merged (into %)', p_winner, v_winner.merged_into;
  END IF;

  -- ── Storage: if BOTH have their own, they are combined below; refuse early when that cannot be done ──────
  SELECT id INTO v_lo FROM store_owners WHERE contact_id = p_loser AND kind = 'person';
  SELECT id INTO v_wo FROM store_owners WHERE contact_id = p_winner AND kind = 'person';
  IF v_lo IS NOT NULL AND v_wo IS NOT NULL THEN
    v_block := public.store_combine_blocker(v_lo, v_wo);
    IF v_block IS NOT NULL THEN RAISE EXCEPTION 'merge_contacts: %', v_block; END IF;
    v_store_both := true;
  END IF;

  -- ── Personal details: decide everything BEFORE changing anything ───────────
  SELECT string_agg(k, ', ') INTO v_bad_choice
  FROM jsonb_object_keys(coalesce(p_field_choices, '{}'::jsonb)) k
  WHERE NOT (k = ANY (c_plain || c_identity || ARRAY['address_line1'])) OR k IN ('passport_expiry_date','itin_issue_date');
  IF v_bad_choice IS NOT NULL THEN
    RAISE EXCEPTION 'merge_contacts: not a personal detail that can be chosen: %', v_bad_choice;
  END IF;
  SELECT string_agg(k || '=' || coalesce(p_field_choices ->> k, 'null'), ', ') INTO v_bad_choice
  FROM jsonb_object_keys(coalesce(p_field_choices, '{}'::jsonb)) k
  WHERE coalesce(p_field_choices ->> k, '') NOT IN ('loser', 'winner');
  IF v_bad_choice IS NOT NULL THEN
    RAISE EXCEPTION 'merge_contacts: a choice must be "loser" or "winner": %', v_bad_choice;
  END IF;

  v_lj := to_jsonb(v_loser);
  v_wj := to_jsonb(v_winner);
  FOREACH v_field IN ARRAY (c_plain || c_identity) LOOP
    v_lv := nullif(regexp_replace(v_lj ->> v_field, '^\s+|\s+$', '', 'g'), '');
    v_wv := nullif(regexp_replace(v_wj ->> v_field, '^\s+|\s+$', '', 'g'), '');
    v_choice := p_field_choices ->> v_field;
    IF v_field IN ('passport_expiry_date','itin_issue_date') THEN
      CONTINUE;                                   -- handled below, together with its own number
    ELSIF v_lv IS NULL THEN
      CONTINUE;                                   -- nothing on the removed contact to copy
    ELSIF v_field IN ('phone','phone_2','phone_3','phone_4') AND EXISTS (
      SELECT 1 FROM unnest(ARRAY['phone','phone_2','phone_3','phone_4']) pf
      WHERE lower(regexp_replace(coalesce(v_wj ->> pf, ''), '[^[:alnum:]]', '', 'g')) = lower(regexp_replace(v_lv, '[^[:alnum:]]', '', 'g'))
        AND lower(regexp_replace(v_lv, '[^[:alnum:]]', '', 'g')) <> '') THEN
      CONTINUE;                                   -- the kept contact already has this number in some phone slot
    ELSIF v_wv IS NULL THEN
      IF v_choice IS DISTINCT FROM 'winner' THEN  -- copy-if-empty (unless the person said "do not copy")
        v_copied := v_copied || jsonb_build_object(v_field, v_lj -> v_field);
      END IF;
    ELSIF (lower(regexp_replace(v_lv, '[^[:alnum:]]', '', 'g')) <> ''
           AND lower(regexp_replace(v_lv, '[^[:alnum:]]', '', 'g')) = lower(regexp_replace(v_wv, '[^[:alnum:]]', '', 'g')))
       OR lower(v_lv) = lower(v_wv) THEN
      CONTINUE;                                   -- the same value written differently
    ELSE                                          -- both have a different value
      IF v_choice = 'loser' THEN
        v_from_loser := v_from_loser || jsonb_build_object(v_field, v_lj -> v_field);
      ELSIF v_choice = 'winner' THEN
        v_kept := v_kept || jsonb_build_object(v_field, v_wj -> v_field);
      ELSIF v_field = ANY (c_identity) THEN
        v_unresolved := v_unresolved || v_field;
      ELSE
        v_kept := v_kept || jsonb_build_object(v_field, v_wj -> v_field);   -- no explicit choice: the kept value stays
      END IF;
    END IF;
  END LOOP;

  -- The address as one block
  v_choice := p_field_choices ->> 'address_line1';
  SELECT bool_or(nullif(regexp_replace(v_lj ->> a, '^\s+|\s+$', '', 'g'), '') IS NOT NULL),
         string_agg(lower(regexp_replace(coalesce(v_lj ->> a, ''), '[^[:alnum:]]', '', 'g')), '|')
    INTO v_l_has, v_l_norm FROM unnest(c_addr) a;
  SELECT bool_or(nullif(regexp_replace(v_wj ->> a, '^\s+|\s+$', '', 'g'), '') IS NOT NULL),
         string_agg(lower(regexp_replace(coalesce(v_wj ->> a, ''), '[^[:alnum:]]', '', 'g')), '|')
    INTO v_w_has, v_w_norm FROM unnest(c_addr) a;
  IF v_l_has THEN
    IF NOT v_w_has THEN
      IF v_choice IS DISTINCT FROM 'winner' THEN
        FOREACH v_field IN ARRAY c_addr LOOP
          IF nullif(regexp_replace(v_lj ->> v_field, '^\s+|\s+$', '', 'g'), '') IS NOT NULL THEN
            v_copied := v_copied || jsonb_build_object(v_field, v_lj -> v_field);
          END IF;
        END LOOP;
      END IF;
    ELSIF v_l_norm <> v_w_norm THEN
      IF v_choice = 'loser' THEN
        FOREACH v_field IN ARRAY c_addr LOOP
          v_from_loser := v_from_loser || jsonb_build_object(v_field, v_lj -> v_field);
        END LOOP;
      ELSE
        v_kept := v_kept || jsonb_build_object('address_line1', v_wj -> 'address_line1');
      END IF;
    END IF;
  END IF;

  -- A passport expiry / ITIN issue date goes WITH its own number and is never chosen on its own:
  --   number taken from the removed contact (copied or chosen) -> its date comes too (the kept date is replaced);
  --   same number on both -> the date is copied only when the kept one has none;
  --   removed contact has no number -> its date is copied only when the kept one has none;
  --   the kept contact's number stays (conflict) -> the other person's date is not copied.
  FOREACH v_dep SLICE 1 IN ARRAY ARRAY[ARRAY['passport_expiry_date','passport_number'], ARRAY['itin_issue_date','itin_number']] LOOP
    v_lv := nullif(regexp_replace(v_lj ->> v_dep[1], '^\s+|\s+$', '', 'g'), '');   -- removed date
    v_wv := nullif(regexp_replace(v_wj ->> v_dep[1], '^\s+|\s+$', '', 'g'), '');   -- kept date
    v_l_norm := lower(regexp_replace(coalesce(v_lj ->> v_dep[2], ''), '[^[:alnum:]]', '', 'g'));  -- removed number
    v_w_norm := lower(regexp_replace(coalesce(v_wj ->> v_dep[2], ''), '[^[:alnum:]]', '', 'g'));  -- kept number
    IF (v_copied ? v_dep[2]) OR (v_from_loser ? v_dep[2]) THEN
      IF v_lv IS NOT NULL THEN
        v_from_loser := v_from_loser || jsonb_build_object(v_dep[1], v_lj -> v_dep[1]);
      ELSIF v_wv IS NOT NULL AND v_w_norm <> '' THEN
        v_from_loser := v_from_loser || jsonb_build_object(v_dep[1], NULL::text);   -- the kept date belonged to the number that is replaced
      END IF;
    ELSIF v_lv IS NOT NULL AND v_wv IS NULL AND (v_l_norm = '' OR v_l_norm = v_w_norm) THEN
      v_copied := v_copied || jsonb_build_object(v_dep[1], v_lj -> v_dep[1]);
    END IF;
  END LOOP;

  IF array_length(v_unresolved, 1) > 0 THEN
    RAISE EXCEPTION 'merge_contacts: the two contacts have different values for % — choose which one is right', array_to_string(v_unresolved, ', ');
  END IF;

  -- ── Owner-less personal documents given to the kept contact ───────────────
  IF coalesce(array_length(p_document_ids, 1), 0) > 0 THEN
    SELECT count(*) INTO v_doc_ok
    FROM documents d
    WHERE d.id = ANY (p_document_ids)
      AND d.category = 2 AND d.contact_id IS NULL
      AND d.account_id IN (SELECT ac.account_id FROM account_contacts ac WHERE ac.contact_id IN (p_loser, p_winner));
    IF v_doc_ok <> (SELECT count(DISTINCT x) FROM unnest(p_document_ids) x) THEN
      RAISE EXCEPTION 'merge_contacts: some of the chosen documents are not personal documents without an owner on these contacts'' companies';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'file_name', d.file_name, 'account_id', d.account_id, 'owner_before', NULL)), '[]'::jsonb)
      INTO v_doc_snap FROM documents d WHERE d.id = ANY (p_document_ids);
    UPDATE documents SET contact_id = p_winner, updated_at = now() WHERE id = ANY (p_document_ids);
  END IF;

  -- Apply the copies
  FOR v_field IN SELECT jsonb_object_keys(v_copied) LOOP
    EXECUTE format('UPDATE public.contacts SET %1$I = (SELECT %1$I FROM public.contacts WHERE id = $1), updated_at = now() WHERE id = $2', v_field)
      USING p_loser, p_winner;
  END LOOP;
  FOR v_field IN SELECT jsonb_object_keys(v_from_loser) LOOP
    EXECUTE format('UPDATE public.contacts SET %1$I = (SELECT %1$I FROM public.contacts WHERE id = $1), updated_at = now() WHERE id = $2', v_field)
      USING p_loser, p_winner;
  END LOOP;

  -- Snapshot then delete loser account links that would collide with the winner's
  -- (account_contacts is UNIQUE on (account_id, contact_id)). The non-colliding
  -- ones fall through to the generic reassignment loop below.
  SELECT coalesce(jsonb_agg(to_jsonb(ac)), '[]'::jsonb) INTO v_deleted_links
  FROM account_contacts ac
  WHERE ac.contact_id = p_loser
    AND EXISTS (SELECT 1 FROM account_contacts w WHERE w.contact_id = p_winner AND w.account_id = ac.account_id);

  DELETE FROM account_contacts ac
  WHERE ac.contact_id = p_loser
    AND EXISTS (SELECT 1 FROM account_contacts w WHERE w.contact_id = p_winner AND w.account_id = ac.account_id);

  -- Reassign every FK column that references contacts(id) (except the contacts
  -- table's own self-reference, handled separately) from loser → winner.
  -- The foreign keys are read from pg_constraint (visible to every role), NOT information_schema (owner-only).
  FOR v_fk IN
    SELECT cl.relname AS table_name, a.attname AS column_name
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.contacts'::regclass
      AND array_length(con.conkey, 1) = 1
      AND cl.relname <> 'contacts'
      AND NOT (v_store_both AND cl.relname = 'store_owners')   -- combined below, not re-pointed
    ORDER BY cl.relname, a.attname
  LOOP
    EXECUTE format('UPDATE public.%I SET %I = $1 WHERE %I = $2', v_fk.table_name, v_fk.column_name, v_fk.column_name)
      USING p_winner, p_loser;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
      v_reassign := v_reassign || jsonb_build_object(v_fk.table_name || '.' || v_fk.column_name, v_count);
      v_total := v_total + v_count;
    END IF;
  END LOOP;

  -- Both had their own storage: combine them now (the people on the files already point at the kept contact)
  IF v_store_both THEN
    v_combined := public.store_combine_owners(v_lo, v_wo, NULL, false);
    v_total := v_total + coalesce((v_combined ->> 'files_moved')::bigint, 0);
  END IF;

  -- Re-point any contact that was merged into the loser → the winner (chain fix).
  UPDATE contacts SET merged_into = p_winner WHERE merged_into = p_loser;

  -- Fold loser emails into winner.alt_emails (lowercased, deduped, minus winner's primary).
  SELECT array_agg(DISTINCT e) INTO v_new_alts
  FROM (
    SELECT lower(x) AS e
    FROM unnest(
      coalesce(v_winner.alt_emails, '{}') ||
      coalesce(v_loser.alt_emails, '{}') ||
      CASE WHEN v_loser.email IS NULL THEN '{}'::text[] ELSE ARRAY[v_loser.email] END
    ) AS x
  ) s
  WHERE e IS NOT NULL AND e <> '' AND e <> lower(coalesce(v_winner.email, ''));

  UPDATE contacts SET alt_emails = coalesce(v_new_alts, '{}'), updated_at = now() WHERE id = p_winner;

  -- Mark loser merged + blank its email so it can never match or duplicate again.
  UPDATE contacts SET merged_into = p_winner, email = NULL, updated_at = now() WHERE id = p_loser;

  INSERT INTO contact_merge_log (loser_id, winner_id, merged_by, reassignment, snapshot)
  VALUES (
    p_loser, p_winner, p_merged_by, v_reassign,
    jsonb_build_object(
      'loser_contact', to_jsonb(v_loser),
      'winner_before', to_jsonb(v_winner),
      'deleted_account_links', v_deleted_links,
      'field_copy', jsonb_build_object(
        'copied_into_empty', v_copied,
        'chosen_from_removed', v_from_loser,
        'kept_on_conflict', v_kept,
        'choices', coalesce(p_field_choices, '{}'::jsonb)),
      'documents_assigned', v_doc_snap,
      'storage_combined', coalesce(v_combined, 'null'::jsonb)
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'loser', p_loser, 'winner', p_winner,
    'rows_reassigned', v_total, 'reassignment', v_reassign,
    'deleted_account_links', jsonb_array_length(v_deleted_links),
    'fields_copied', (SELECT coalesce(jsonb_agg(k), '[]'::jsonb) FROM (SELECT jsonb_object_keys(v_copied) k UNION SELECT jsonb_object_keys(v_from_loser)) u),
    'documents_assigned', jsonb_array_length(v_doc_snap),
    'storage_combined', v_combined
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
COMMIT;
