-- merge_contacts(): make it move EVERYTHING when run by the app (Antonio 2026-10-21, "build the Merge button properly").
-- WHY: the function finds the tables that point at a contact through information_schema, which only lists constraints on tables the CURRENT
-- role owns. Run by the postgres role (the SQL editor) it finds them all; run by the app's service role (the CRM route) it finds NONE: it
-- moved nothing, then still marked the loser as merged and blanked its email. Found in the sandbox: reassignment = {} for a contact that
-- owned a storage, an ownership record and a company link.
-- WHAT: the lookup now reads the system catalog (pg_constraint), which every role can read. Everything else in the function is unchanged.
-- Safe to run again (CREATE OR REPLACE). Undo: the .UNDO.sql beside this file restores the previous definition.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.merge_contacts(p_loser uuid, p_winner uuid, p_merged_by text DEFAULT NULL::text)
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
      'deleted_account_links', v_deleted_links
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'loser', p_loser, 'winner', p_winner,
    'rows_reassigned', v_total, 'reassignment', v_reassign,
    'deleted_account_links', jsonb_array_length(v_deleted_links)
  );
END;
$function$;

COMMIT;
