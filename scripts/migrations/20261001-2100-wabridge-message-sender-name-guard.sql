-- Close the one remaining doorway for the business's own name to land on a client's message.
-- Antonio (2026-10-01): "I don't want a system patched. I want a fucking solid system" — after a
-- Bug-Hunter sweep found that today's three-layer fix for the CHAT name left the per-MESSAGE sender
-- caption uncovered. Confirmed live: 123 historical messages already carry sender_name = 'Tony
-- Durante LLC' (all from before 2026-09-01 — dormant, not an active leak right now), and the write
-- path that could reproduce it today has zero guard.
--
-- Verified there is exactly ONE live caller of this function for WhatsApp traffic
-- (app/api/wa-bridge/[channelId]/route.ts) — unlike group_name, which had two independent write
-- paths, sender_name only ever enters here, which is why a single fix at this one doorway is the
-- complete, solid fix: every current and future reader (the Inbox thread, the MCP tools, the AI
-- worker context) is automatically protected with nothing left to remember or duplicate.
--
-- Sandbox: node scripts/apply-migration.js scripts/migrations/20261001-2100-wabridge-message-sender-name-guard.sql
-- Production: Antonio runs it in the Supabase SQL editor (execute_sql DDL promotion path is retired).

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
    is_active = CASE WHEN p_direction = 'inbound' THEN true ELSE is_active END,
    last_message_at = GREATEST(COALESCE(last_message_at, p_created_at), p_created_at),
    updated_at = now()
  WHERE id = p_group_id;

  RETURN true;
END;
$function$;
