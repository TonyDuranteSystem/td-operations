-- Who is in a WhatsApp group (2026-11-20, Antonio: "I want to see who is in the group").
-- 1) messaging_groups.members: the group's members as the phone lists them — a JSON array of {phone, name, admin}. NULL = not reported yet.
-- 2) wabridge_apply_groups now also stores the members the Mac sends (only when it sends them, only when they changed).
ALTER TABLE public.messaging_groups ADD COLUMN IF NOT EXISTS members jsonb;

CREATE OR REPLACE FUNCTION public.wabridge_apply_groups(p_channel_id uuid, p_groups jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item jsonb;
  v_jid text;
  v_name text;
  v_members jsonb;
  v_changed integer := 0;
  v_rows integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM messaging_channels c WHERE c.id = p_channel_id AND c.provider = 'wabridge') THEN
    RETURN 0;
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_groups, '[]'::jsonb))
  LOOP
    v_jid := v_item->>'jid';
    v_name := NULLIF(btrim(COALESCE(v_item->>'name', '')), '');
    v_members := CASE WHEN jsonb_typeof(v_item->'members') = 'array' THEN v_item->'members' ELSE NULL END;
    IF v_jid IS NULL OR v_jid !~ '^[0-9]{8,30}(-[0-9]+)?@g\.us$' THEN
      CONTINUE;
    END IF;
    INSERT INTO messaging_groups (channel_id, external_group_id, group_name, group_type, is_active, last_message_at, members)
    VALUES (p_channel_id, v_jid, v_name, 'support_group', true, now(), v_members)
    ON CONFLICT (channel_id, external_group_id) DO UPDATE
      SET group_name = COALESCE(EXCLUDED.group_name, messaging_groups.group_name),
          members = COALESCE(EXCLUDED.members, messaging_groups.members),
          updated_at = now()
      WHERE (EXCLUDED.group_name IS NOT NULL AND messaging_groups.group_name IS DISTINCT FROM EXCLUDED.group_name)
         OR (EXCLUDED.members IS NOT NULL AND messaging_groups.members IS DISTINCT FROM EXCLUDED.members);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_changed + v_rows;
  END LOOP;
  RETURN v_changed;
END;
$function$;

REVOKE ALL ON FUNCTION public.wabridge_apply_groups(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_apply_groups(uuid, jsonb) TO service_role;
