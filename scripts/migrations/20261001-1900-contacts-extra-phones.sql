-- Add two more phone slots to a client's contact record.
-- Antonio (2026-10-01): a client can have more than one real number in active use (e.g. an Italian
-- WhatsApp number alongside the American number already on file) and the existing phone/phone_2
-- pair isn't enough to capture both — which is exactly why Claudia Taffarello (Snowfy LLC) didn't
-- auto-match her WhatsApp chat: her US number is on file, her Italian WhatsApp number wasn't
-- stored anywhere the matcher could see.
--
-- Leads deliberately keep their single phone field — this only applies to contacts (clients).
--
-- Sandbox: node scripts/apply-migration.js scripts/migrations/20261001-1900-contacts-extra-phones.sql
-- Production: Antonio runs it in the Supabase SQL editor (execute_sql DDL promotion path is retired).

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS phone_3 text,
  ADD COLUMN IF NOT EXISTS phone_4 text;

-- wabridge_link_chat (the automatic WhatsApp-to-client matcher) must check the two new slots too,
-- or they'd just sit there unused. Identical to the live function except the contact phone-match
-- CTE now also compares phone_3 and phone_4.
CREATE OR REPLACE FUNCTION public.wabridge_link_chat(p_group_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    RETURN 'already';
  END IF;
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
         OR regexp_replace(COALESCE(c.phone_2, ''), '\D', '', 'g') = v_digits
         OR regexp_replace(COALESCE(c.phone_3, ''), '\D', '', 'g') = v_digits
         OR regexp_replace(COALESCE(c.phone_4, ''), '\D', '', 'g') = v_digits);

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
    IF v_contact IS NOT NULL AND NOT (v_contact = ANY (v_contact_ids)) THEN
      v_contact := NULL;
    END IF;
  ELSE
    v_contact := v_extra_contacts[1];
  END IF;

  v_chat_words := COALESCE(cardinality(wabridge_name_tokens(v_chat_name)), 0);
  IF v_chat_words > 0 THEN
    SELECT full_name INTO v_lead_name FROM leads WHERE id = v_lead;
    SELECT full_name INTO v_contact_name FROM contacts WHERE id = v_contact;
    v_agree_l := wabridge_names_agree(v_chat_name, v_lead_name);
    v_agree_c := wabridge_names_agree(v_chat_name, v_contact_name);
    IF v_agree_l IS TRUE OR v_agree_c IS TRUE THEN
      NULL;
    ELSIF v_agree_l IS NOT NULL OR v_agree_c IS NOT NULL THEN
      RETURN 'mismatch';
    ELSE
      v_chat_words := 0;
    END IF;
  END IF;

  IF v_chat_words = 0 THEN
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
$function$;
