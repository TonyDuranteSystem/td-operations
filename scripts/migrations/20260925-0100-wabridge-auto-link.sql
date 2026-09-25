-- WhatsApp bridge (dev job 907b2535): link a chat to its lead/contact by PHONE NUMBER, automatically.
-- Antonio 2026-09-24: "WA in the CRM must recognize the phone number, not Unknown ... when I save the phone number on
-- the phone or on the CRM with name and last name, the two must be updated" and "can this be done immediately".
--
-- Rules (deliberately conservative — a wrong link puts a real person's messages under someone else's name):
--  - NEVER overwrite an existing link: a chat that already has a lead / contact / account is left alone.
--  - Match on the FULL number (all digits equal — the 2026-09-18 ruling: never a last-N-digits guess).
--  - Exactly ONE person must match. A lead and the contact it was converted into (leads.converted_to_contact_id) are
--    ONE person; two different people sharing a number = 'ambiguous' = left for a human.
--  - Test records (is_test) and merged-away contacts (merged_into) are ignored.
--  - Sets lead_id and/or contact_id only (the account is not guessed).
--  - SECOND SIGNAL, the NAME: when the chat carries a comparable name (the phone-saved name, or the sender's WhatsApp
--    name), one name must be FULLY CONTAINED in the other, word for word (accents/case ignored, words < 3 letters ignored):
--    'Barnabas' is inside 'Barnabás Zahola' -> agree; 'Maria Rossi' vs 'Marco Rossi' -> NOT (a shared surname is not enough);
--    'Ste' vs 'Stefano' -> NOT (nicknames go to a person). A disagreement = 'mismatch' = left unlinked.
--  - NO comparable name on either side (null, 'Unknown', just a number, non-Latin script, initials only) = the chat can
--    only be matched on the number. That is allowed ONLY after (a) the phone's names have been synced into this channel at
--    least once (wa_bridge_state.names_synced_at) and (b) the chat is at least 3 minutes old — so a recycled number cannot be
--    linked to its old owner in the window before the real name arrives. Until then the result is 'waiting'.
--
-- wabridge_name_tokens(n)        : comparable words of a name (lowercase ASCII, >= 3 letters).
-- wabridge_names_agree(a, b)     : true / false, or NULL when one side has no comparable words.
-- wabridge_link_chat(group)      : link one chat: 'linked' | 'already' | 'none' | 'ambiguous' | 'mismatch' | 'waiting'.
-- wabridge_link_unlinked(channel): sweep a channel's active unlinked chats (run each minute by /api/cron/wa-bridge-link);
--                                  returns jsonb counts per outcome so held-back chats are visible in the cron log.
-- wabridge_apply_names(...)      : (re-defined) additionally stamps wa_bridge_state.names_synced_at.
--
-- Sandbox: statement-by-statement via exec_sql (scratchpad sbx-migrate.js). Production: Antonio runs it in the Supabase SQL editor.

ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS names_synced_at timestamptz;

CREATE OR REPLACE FUNCTION public.wabridge_name_tokens(n text) RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(array_agg(DISTINCT w ORDER BY w), '{}'::text[])
  FROM unnest(regexp_split_to_array(lower(translate(COALESCE(n, ''), 'ÀÁÂÃÄÅĂĄàáâãäåăąÇĆČçćčÈÉÊËĚĘèéêëěęÌÍÎÏìíîïŁłÑŃñńÒÓÔÕÖŐØòóôõöőøŘřŕŠŚȘßšśșȚțÙÚÛÜŰùúûüűÝŸýÿŽŹŻžźż', 'aaaaaaaaaaaaaaaacccccceeeeeeeeeeeeiiiiiiiillnnnnoooooooooooooorrrsssssssttuuuuuuuuuuyyyyzzzzzz')), '[^a-z]+')) AS t(w)
  WHERE length(w) >= 3;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_names_agree(a text, b text) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  ta text[] := wabridge_name_tokens(a);
  tb text[] := wabridge_name_tokens(b);
BEGIN
  IF COALESCE(cardinality(ta), 0) = 0 OR COALESCE(cardinality(tb), 0) = 0 THEN
    RETURN NULL; -- cannot be compared
  END IF;
  RETURN ta <@ tb OR tb <@ ta;
END;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_link_chat(p_group_id uuid) RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_digits text;
  v_chat_name text;
  v_channel uuid;
  v_created timestamptz;
  v_lead_ids uuid[];
  v_contact_ids uuid[];
  v_extra_contacts uuid[];
  v_persons integer;
  v_lead uuid;
  v_contact uuid;
  v_lead_name text;
  v_contact_name text;
  v_agree_l boolean;
  v_agree_c boolean;
  v_chat_words integer;
BEGIN
  SELECT regexp_replace(g.external_group_id, '\D', '', 'g'), g.group_name, g.channel_id, g.created_at
    INTO v_digits, v_chat_name, v_channel, v_created
  FROM messaging_groups g
  WHERE g.id = p_group_id AND g.lead_id IS NULL AND g.contact_id IS NULL AND g.account_id IS NULL;
  IF NOT FOUND THEN
    RETURN 'already'; -- unknown group, or it already has a link: never overwrite
  END IF;
  -- a real phone number only (group jids / junk keys are never matched)
  IF length(v_digits) < 8 OR length(v_digits) > 15 THEN
    RETURN 'none';
  END IF;

  SELECT COALESCE(array_agg(l.id), '{}') INTO v_lead_ids
  FROM leads l
  WHERE COALESCE(l.is_test, false) = false
    AND regexp_replace(COALESCE(l.phone, ''), '\D', '', 'g') = v_digits;

  SELECT COALESCE(array_agg(c.id), '{}') INTO v_contact_ids
  FROM contacts c
  WHERE COALESCE(c.is_test, false) = false
    AND c.merged_into IS NULL
    AND (regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g') = v_digits
         OR regexp_replace(COALESCE(c.phone_2, ''), '\D', '', 'g') = v_digits);

  -- contacts that are just the converted form of a matched lead are the SAME person
  SELECT COALESCE(array_agg(c), '{}') INTO v_extra_contacts
  FROM unnest(v_contact_ids) AS c
  WHERE c NOT IN (SELECT l.converted_to_contact_id FROM leads l WHERE l.id = ANY (v_lead_ids) AND l.converted_to_contact_id IS NOT NULL);

  v_persons := COALESCE(array_length(v_lead_ids, 1), 0) + COALESCE(array_length(v_extra_contacts, 1), 0);
  IF v_persons = 0 THEN
    RETURN 'none';
  END IF;
  IF v_persons > 1 THEN
    RETURN 'ambiguous';
  END IF;

  IF COALESCE(array_length(v_lead_ids, 1), 0) = 1 THEN
    v_lead := v_lead_ids[1];
    SELECT l.converted_to_contact_id INTO v_contact FROM leads l WHERE l.id = v_lead;
    -- take the converted contact only if it really carries this number too
    IF v_contact IS NOT NULL AND NOT (v_contact = ANY (v_contact_ids)) THEN
      v_contact := NULL;
    END IF;
  ELSE
    v_contact := v_extra_contacts[1];
  END IF;

  -- SECOND SIGNAL: the name
  v_chat_words := COALESCE(cardinality(wabridge_name_tokens(v_chat_name)), 0);
  IF v_chat_words > 0 THEN
    SELECT full_name INTO v_lead_name FROM leads WHERE id = v_lead;
    SELECT full_name INTO v_contact_name FROM contacts WHERE id = v_contact;
    v_agree_l := wabridge_names_agree(v_chat_name, v_lead_name);
    v_agree_c := wabridge_names_agree(v_chat_name, v_contact_name);
    IF v_agree_l IS TRUE OR v_agree_c IS TRUE THEN
      NULL; -- names agree: link
    ELSIF v_agree_l IS NOT NULL OR v_agree_c IS NOT NULL THEN
      RETURN 'mismatch'; -- comparable names, and they disagree
    ELSE
      v_chat_words := 0; -- CRM side has no comparable name: fall to the number-only rules
    END IF;
  END IF;

  IF v_chat_words = 0 THEN
    -- number-only match: only once the phone's names have been synced for this channel and the chat is not brand new
    IF NOT EXISTS (SELECT 1 FROM wa_bridge_state s WHERE s.channel_id = v_channel AND s.names_synced_at IS NOT NULL)
       OR v_created > now() - interval '3 minutes' THEN
      RETURN 'waiting';
    END IF;
  END IF;

  UPDATE messaging_groups
  SET lead_id = v_lead, contact_id = v_contact, updated_at = now()
  WHERE id = p_group_id AND lead_id IS NULL AND contact_id IS NULL AND account_id IS NULL;
  RETURN 'linked';
END;
$$;

DROP FUNCTION IF EXISTS public.wabridge_link_unlinked(uuid);

CREATE OR REPLACE FUNCTION public.wabridge_link_unlinked(p_channel_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group uuid;
  v_result text;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  FOR v_group IN
    SELECT g.id FROM messaging_groups g
    WHERE g.channel_id = p_channel_id AND g.is_active
      AND g.lead_id IS NULL AND g.contact_id IS NULL AND g.account_id IS NULL
      AND g.external_group_id NOT LIKE '%@g.us'
  LOOP
    v_result := wabridge_link_chat(v_group);
    v_counts := jsonb_set(v_counts, ARRAY[v_result], to_jsonb(COALESCE((v_counts->>v_result)::integer, 0) + 1));
  END LOOP;
  RETURN v_counts;
END;
$$;

-- wabridge_apply_names: unchanged behaviour + stamps that the phone's names have now been synced for this channel
CREATE OR REPLACE FUNCTION public.wabridge_apply_names(p_channel_id uuid, p_names jsonb) RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item jsonb;
  v_digits text;
  v_name text;
  v_rows integer;
  v_total integer := 0;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_names, '[]'::jsonb))
  LOOP
    v_digits := regexp_replace(COALESCE(v_item->>'digits', ''), '\D', '', 'g');
    v_name := btrim(COALESCE(v_item->>'name', ''));
    -- skip junk: no/short number, empty name, or a "name" that is just the number
    CONTINUE WHEN length(v_digits) < 6 OR length(v_digits) > 15 OR v_name = ''
      OR regexp_replace(v_name, '\D', '', 'g') = v_digits;
    UPDATE messaging_groups SET group_name = v_name, updated_at = now()
    WHERE channel_id = p_channel_id
      AND external_group_id IN (v_digits || '@c.us', v_digits)
      AND group_name IS DISTINCT FROM v_name;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;
  END LOOP;

  INSERT INTO wa_bridge_state (channel_id, names_synced_at) VALUES (p_channel_id, now())
  ON CONFLICT (channel_id) DO UPDATE SET names_synced_at = now();

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_name_tokens(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_name_tokens(text) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_names_agree(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_names_agree(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_link_chat(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_link_chat(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_link_unlinked(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_link_unlinked(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_apply_names(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_apply_names(uuid, jsonb) TO service_role;
