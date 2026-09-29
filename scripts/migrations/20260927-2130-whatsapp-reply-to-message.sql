-- Part of the WhatsApp "three dots" menu (Antonio 2026-09-27, "full menu"): reply to a specific
-- message. The reply target has to survive the ENTIRE existing send queue (compose → wa_outbox →
-- the Mac sends it → wabridge_finish_send writes the real messages row) before it can be set on the
-- real row, so this carries it through the same way the rest of that pipeline already carries body/kind.

ALTER TABLE public.wa_outbox ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES public.messages(id);

-- The old 4-arg signature is dropped, not just superseded: leaving both around makes ANY 4-arg call
-- genuinely ambiguous to Postgres ("not unique") since the new 5th param has a default — confirmed
-- by hitting this exact error while testing. The one caller (the reply route) is updated in the same
-- change to always pass 5 args (reply_to_id explicitly, null when not replying).
DO $$ BEGIN DROP FUNCTION IF EXISTS public.wabridge_enqueue_reply(uuid, text, text, uuid); END $$;

-- wabridge_enqueue_reply: same as before, plus an optional reply target, stored alongside the queued row.
CREATE OR REPLACE FUNCTION public.wabridge_enqueue_reply(
  p_group_id uuid, p_body text, p_client_msg_id text, p_created_by uuid, p_reply_to_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_channel uuid;
  v_key text;
  v_group_active boolean;
  v_provider text;
  v_channel_active boolean;
  v_digits text;
  v_body text;
  v_mode text;
  v_allow text[];
  v_existing record;
  v_id uuid;
  v_status text;
BEGIN
  IF p_body IS NULL OR length(btrim(p_body)) < 1 OR length(p_body) > 4096 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_body', 'message', 'Message must be 1-4096 characters.');
  END IF;
  IF p_client_msg_id IS NULL OR length(p_client_msg_id) < 8 OR length(p_client_msg_id) > 100 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_request', 'message', 'Missing message id — please reload the page and try again.');
  END IF;
  v_body := btrim(p_body);

  SELECT g.channel_id, g.external_group_id, g.is_active INTO v_channel, v_key, v_group_active
  FROM messaging_groups g WHERE g.id = p_group_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'Conversation not found.');
  END IF;

  SELECT c.provider, c.is_active INTO v_provider, v_channel_active FROM messaging_channels c WHERE c.id = v_channel;
  IF NOT FOUND OR v_provider IS DISTINCT FROM 'wabridge' OR v_channel_active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_wabridge', 'message', 'This WhatsApp line is not on the self-hosted link.');
  END IF;
  IF v_group_active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'code', 'inactive', 'message', 'This chat is hidden — it cannot be replied to from the CRM.');
  END IF;

  IF v_key !~ '^[0-9]{6,15}(@c\.us)?$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_one_to_one', 'message', 'This chat is not a real 1:1 phone chat.');
  END IF;
  v_digits := regexp_replace(v_key, '\D', '', 'g');

  SELECT o.id, o.status INTO v_existing FROM wa_outbox o WHERE o.channel_id = v_channel AND o.client_msg_id = p_client_msg_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
  END IF;

  SELECT s.send_mode, s.send_allowlist INTO v_mode, v_allow FROM wa_bridge_state s WHERE s.channel_id = v_channel;
  IF NOT FOUND OR v_mode IS NULL OR v_mode NOT IN ('shadow', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'paused', 'message', 'Sending from the CRM is paused — reply from the phone for now.');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM messages m WHERE m.group_id = p_group_id AND m.direction = 'inbound') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'no_inbound', 'message', 'You can only reply to people who have written to this number. First contact is made from the phone.');
  END IF;

  IF v_mode = 'live' AND COALESCE(cardinality(v_allow), 0) > 0 AND NOT (v_digits = ANY (v_allow)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_allowed', 'message', 'Sending is limited to test numbers right now.');
  END IF;

  -- a reply target must be a real message in THIS same chat — never trust the client blindly
  IF p_reply_to_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = p_reply_to_id AND m.group_id = p_group_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_reply_to', 'message', 'That message could not be found in this chat.');
  END IF;

  v_status := CASE WHEN v_mode = 'live' THEN 'queued' ELSE 'shadow' END;
  INSERT INTO wa_outbox (channel_id, group_id, to_digits, body, client_msg_id, status, created_by, reply_to_id)
  VALUES (v_channel, p_group_id, v_digits, v_body, p_client_msg_id, v_status, p_created_by, p_reply_to_id)
  ON CONFLICT (channel_id, client_msg_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT o.id, o.status INTO v_existing FROM wa_outbox o WHERE o.channel_id = v_channel AND o.client_msg_id = p_client_msg_id;
    RETURN jsonb_build_object('ok', true, 'id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', v_status);
END;
$$;

-- wabridge_finish_send: the text branch now carries the queued reply target through to the real row.
CREATE OR REPLACE FUNCTION public.wabridge_finish_send(
  p_channel_id uuid, p_outbox_id uuid, p_ok boolean, p_message_id text, p_error text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  o record;
  v_msg_id uuid;
BEGIN
  SELECT * INTO o FROM wa_outbox WHERE id = p_outbox_id AND channel_id = p_channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF o.status = 'sent' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', 'sent');
  END IF;
  IF o.status <> 'unknown' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_in_flight', 'status', o.status);
  END IF;

  IF p_ok THEN
    IF p_message_id IS NULL OR length(btrim(p_message_id)) < 6 OR length(p_message_id) > 200 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_message_id');
    END IF;
    UPDATE wa_outbox SET status = 'sent', sent_at = now(), external_message_id = btrim(p_message_id), error = NULL WHERE id = o.id;

    IF COALESCE(o.kind, 'text') = 'text' THEN
      PERFORM wabridge_ingest_message(
        o.group_id, o.channel_id, btrim(p_message_id), 'outbound', NULL, 'TD Team', 'text', o.body, now(),
        jsonb_build_object('source', 'wabridge', 'sent_from', 'crm', 'outbox_id', o.id, 'reply_to_id', o.reply_to_id), false
      );
    ELSE
      INSERT INTO messages (group_id, channel_id, direction, sender_name, content_type, content_text, status, created_at, external_message_id, metadata)
      VALUES (o.group_id, o.channel_id, 'outbound', 'TD Team', o.kind, o.body, 'responded', now(), btrim(p_message_id),
              jsonb_build_object('source', 'wabridge', 'sent_from', 'crm', 'outbox_id', o.id))
      RETURNING id INTO v_msg_id;
      UPDATE messaging_groups SET last_message_at = GREATEST(COALESCE(last_message_at, now()), now()), updated_at = now() WHERE id = o.group_id;
      IF o.kind = 'voice' THEN
        INSERT INTO message_media (message_id, channel_id, kind, status, storage_path, mime_type, size_bytes, ready_at)
        VALUES (v_msg_id, o.channel_id, 'voice', 'ready', o.media_path, o.media_mime, o.media_size_bytes, now())
        ON CONFLICT (message_id) DO NOTHING;
      END IF;
    END IF;
    RETURN jsonb_build_object('ok', true, 'status', 'sent');
  END IF;

  UPDATE wa_outbox SET status = 'failed', error = left(COALESCE(NULLIF(btrim(p_error), ''), 'send failed'), 500) WHERE id = o.id;
  RETURN jsonb_build_object('ok', true, 'status', 'failed');
END;
$$;

-- wabridge_ingest_message: promote metadata.reply_to_id (a real uuid string, or absent) onto the
-- real reply_to_id column. Every other caller (inbound receive, backfill) simply never sets this key
-- in its metadata, so this is purely additive — no existing behavior changes.
CREATE OR REPLACE FUNCTION public.wabridge_ingest_message(
  p_group_id uuid, p_channel_id uuid, p_external_id text, p_direction text, p_sender_phone text,
  p_sender_name text, p_content_type text, p_content_text text, p_created_at timestamptz,
  p_metadata jsonb, p_backfill boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
  v_reply_to_id uuid;
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

  INSERT INTO messages (
    group_id, channel_id, external_message_id, direction, sender_phone, sender_name,
    content_type, content_text, status, created_at, metadata, reply_to_id
  ) VALUES (
    p_group_id, p_channel_id, p_external_id, p_direction, p_sender_phone, p_sender_name,
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
    is_active = CASE WHEN p_direction = 'inbound' THEN true ELSE is_active END,
    last_message_at = GREATEST(COALESCE(last_message_at, p_created_at), p_created_at),
    updated_at = now()
  WHERE id = p_group_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_enqueue_reply(uuid, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_enqueue_reply(uuid, text, text, uuid, uuid) TO service_role;
