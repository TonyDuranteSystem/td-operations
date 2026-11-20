-- WhatsApp GROUPS (2026-11-19, Antonio: "I don't see when a client creates a group").
-- 1) wabridge_apply_groups(channel, groups jsonb): the Mac lists the phone's groups every minute; each one becomes (or updates) a
--    chat keyed by its own `<digits>@g.us` id. A NEW group appears at the top of the list; an existing one only gets a new name.
--    A hidden (muted) group stays hidden here.
-- 2) wabridge_ingest_message: a new message in a MUTED (hidden) GROUP no longer un-hides it. 1:1 chats keep reviving as before.
-- Both are CREATE OR REPLACE / CREATE: no table or column changes.

CREATE OR REPLACE FUNCTION public.wabridge_apply_groups(p_channel_id uuid, p_groups jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item jsonb;
  v_jid text;
  v_name text;
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
    IF v_jid IS NULL OR v_jid !~ '^[0-9]{8,30}(-[0-9]+)?@g\.us$' THEN
      CONTINUE;
    END IF;
    INSERT INTO messaging_groups (channel_id, external_group_id, group_name, group_type, is_active, last_message_at)
    VALUES (p_channel_id, v_jid, v_name, 'support_group', true, now())
    ON CONFLICT (channel_id, external_group_id) DO UPDATE
      SET group_name = EXCLUDED.group_name, updated_at = now()
      WHERE EXCLUDED.group_name IS NOT NULL AND messaging_groups.group_name IS DISTINCT FROM EXCLUDED.group_name;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_changed + v_rows;
  END LOOP;
  RETURN v_changed;
END;
$function$;

REVOKE ALL ON FUNCTION public.wabridge_apply_groups(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_apply_groups(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.wabridge_ingest_message(p_group_id uuid, p_channel_id uuid, p_external_id text, p_direction text, p_sender_phone text, p_sender_name text, p_content_type text, p_content_text text, p_created_at timestamp with time zone, p_metadata jsonb, p_backfill boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows integer;
  v_reply_to_id uuid;
  v_sender_name text;
BEGIN
  IF p_backfill AND EXISTS (
    SELECT 1 FROM messages m
    WHERE m.group_id = p_group_id
      AND m.direction = p_direction
      AND m.created_at BETWEEN p_created_at - interval '3 minutes' AND p_created_at + interval '3 minutes'
      AND COALESCE(m.metadata->>'source', '') <> 'wabridge'
      AND (
        (p_content_type = 'text' AND m.content_text IS NOT DISTINCT FROM p_content_text)
        OR (p_content_type <> 'text' AND (m.content_type = p_content_type OR (m.content_type = 'other' AND m.content_text IS NULL)))
      )
  ) THEN
    RETURN false;
  END IF;

  BEGIN
    v_reply_to_id := NULLIF(p_metadata->>'reply_to_id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_reply_to_id := NULL; -- a malformed value never blocks the send — it just isn't threaded
  END;

  -- Never let the line's own registered business identity be stored as if it were a real sender's
  -- name, the same rule already applied to a chat's own name (OWN_BUSINESS_NAME in
  -- lib/messaging/chat-name.ts; wabridge_apply_names carries the identical literal by hand, the
  -- same documented trade-off — SQL can't import TS).
  v_sender_name := CASE WHEN lower(btrim(COALESCE(p_sender_name, ''))) = lower('Tony Durante LLC') THEN NULL ELSE p_sender_name END;

  INSERT INTO messages (
    group_id, channel_id, external_message_id, direction, sender_phone, sender_name,
    content_type, content_text, status, created_at, metadata, reply_to_id
  ) VALUES (
    p_group_id, p_channel_id, p_external_id, p_direction, p_sender_phone, v_sender_name,
    p_content_type, p_content_text,
    CASE WHEN p_direction = 'inbound' THEN (CASE WHEN p_backfill THEN 'read' ELSE 'new' END) ELSE 'responded' END,
    p_created_at, COALESCE(p_metadata, '{}'::jsonb), v_reply_to_id
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;

  IF p_backfill THEN
    UPDATE messaging_groups SET
      last_message_at = GREATEST(COALESCE(last_message_at, p_created_at), p_created_at),
      updated_at = now()
    WHERE id = p_group_id;
    RETURN true;
  END IF;

  UPDATE messaging_groups SET
    unread_count = CASE
      WHEN p_direction = 'inbound' THEN unread_count + 1
      WHEN p_created_at >= COALESCE(last_message_at, p_created_at) THEN 0
      ELSE unread_count
    END,
    is_active = CASE WHEN p_direction = 'inbound' AND external_group_id NOT LIKE '%@g.us' THEN true ELSE is_active END, -- a muted GROUP stays muted
    last_message_at = GREATEST(COALESCE(last_message_at, p_created_at), p_created_at),
    updated_at = now()
  WHERE id = p_group_id;

  RETURN true;
END;
$function$;
