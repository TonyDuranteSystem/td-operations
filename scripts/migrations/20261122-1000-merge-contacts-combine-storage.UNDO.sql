-- UNDO of 20261122-1000-merge-contacts-combine-storage.sql: back to merge_contacts() as released in slice 1
-- (two contacts that BOTH have a storage are refused by the app again). Merges already done keep their combined storage.
BEGIN;
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
      'documents_assigned', v_doc_snap
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'loser', p_loser, 'winner', p_winner,
    'rows_reassigned', v_total, 'reassignment', v_reassign,
    'deleted_account_links', jsonb_array_length(v_deleted_links),
    'fields_copied', (SELECT coalesce(jsonb_agg(k), '[]'::jsonb) FROM (SELECT jsonb_object_keys(v_copied) k UNION SELECT jsonb_object_keys(v_from_loser)) u),
    'documents_assigned', jsonb_array_length(v_doc_snap)
  );
END;
$function$;

DROP FUNCTION IF EXISTS public.store_combine_plan(uuid, uuid);
DROP FUNCTION IF EXISTS public.store_combine_owners(uuid, uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.store_combine_blocker(uuid, uuid);
NOTIFY pgrst, 'reload schema';
COMMIT;
