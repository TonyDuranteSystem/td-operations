-- migration:20260527-1625-merge-contacts-function.sql
--
-- Reusable, FK-driven, single-transaction contact merge.
--   merge_contacts(loser, winner, merged_by) →
--     • reassigns EVERY foreign-key reference to contacts(id) from loser→winner
--       by looping the live FK catalog (so no table can be missed)
--     • special-cases the only UNIQUE constraint on contact_id —
--       account_contacts(account_id, contact_id): loser links to an account the
--       winner already has are DELETED (snapshotted first) to avoid a dup-key error;
--       the rest are reassigned by the generic loop
--     • folds the loser's email(s) into winner.alt_emails (lowercased, deduped)
--     • sets loser.merged_into = winner (kept for audit; filtered from lists) and
--       blanks the loser email so it can never match/duplicate again
--     • writes a contact_merge_log row (counts + snapshot of loser row & deleted links)
-- Runs in one transaction (the function body) — partial failure rolls back fully.
-- Idempotent: a re-run on an already-merged loser raises (caught by callers).

CREATE OR REPLACE FUNCTION merge_contacts(p_loser uuid, p_winner uuid, p_merged_by text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_loser     contacts%ROWTYPE;
  v_winner    contacts%ROWTYPE;
  v_fk        record;
  v_count     bigint;
  v_total     bigint := 0;
  v_reassign  jsonb := '{}'::jsonb;
  v_deleted_links jsonb := '[]'::jsonb;
  v_new_alts  text[];
BEGIN
  IF p_loser = p_winner THEN
    RAISE EXCEPTION 'merge_contacts: loser and winner must differ';
  END IF;

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
  FOR v_fk IN
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'contacts' AND ccu.column_name = 'id'
      AND tc.table_name <> 'contacts'
  LOOP
    EXECUTE format('UPDATE %I SET %I = $1 WHERE %I = $2', v_fk.table_name, v_fk.column_name, v_fk.column_name)
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
      'deleted_account_links', v_deleted_links
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'loser', p_loser, 'winner', p_winner,
    'rows_reassigned', v_total, 'reassignment', v_reassign,
    'deleted_account_links', jsonb_array_length(v_deleted_links)
  );
END;
$$;
