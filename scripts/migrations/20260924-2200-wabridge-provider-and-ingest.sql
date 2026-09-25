-- WhatsApp self-hosted bridge (dev job 907b2535): provider value, bridge state, atomic ingest, names.
-- ONE migration for the whole bridge so production needs a single run (council review 2026-09-24 folded in).
--
-- 1. Allow 'wabridge' as a messaging_channels.provider — our own linked-device bridge (GOWA on the
--    Mac Mini) that replaces the expired 2Chat subscription.
-- 2. wa_bridge_state: the bridge's health lives in its OWN row, not in messaging_channels.config_json.
--    The heartbeat (every 60 s) and the alert cron used to read-modify-write the same JSON blob and
--    overwrote each other (repeat alerts / lost recovery marker). Each writer now touches only its own
--    columns through an atomic RPC.
-- 3. wabridge_ingest_message(): insert one message AND update its conversation in ONE transaction,
--    deduped on the provider message id.
--    - inbound  : unread+1, revives a hidden conversation
--    - outbound : a message typed on the phone — clears unread ONLY if it is not older than the newest
--                 known message (a back-filled old reply must not zero a newer unread), never revives
--    - p_backfill = true (history download): inserts as already-read/responded, changes NO unread,
--                 revives NOTHING; last_message_at only moves forward. It also SKIPS a message that a
--                 LEGACY source (2Chat / the old import — anything not saved by this bridge) already stored for the
--                 same chat: same direction and (same text, or same media kind — including the untyped `other`/no-text media rows 2Chat wrote) within 3 minutes. Those rows carry
--                 provider ids that differ from WhatsApp's, so the unique id cannot catch them and the history
--                 download would otherwise duplicate every message 2Chat already saved. (Backfill only — a LIVE
--                 message is never matched on text, which would swallow a legitimate second "ok".)
-- 4. wabridge_apply_names(): sync the phone's saved contact names into messaging_groups.group_name
--    (matches both key shapes: canonical '<digits>@c.us' and the ~169 legacy bare-digit keys).
--
-- Sandbox: statement-by-statement via the exec_sql RPC (see scratchpad sbx-migrate.js) or apply-migration.js.
-- Production: Antonio runs it in the Supabase SQL editor after sandbox QA.

ALTER TABLE messaging_channels DROP CONSTRAINT IF EXISTS messaging_channels_provider_check;

ALTER TABLE messaging_channels ADD CONSTRAINT messaging_channels_provider_check
  CHECK (provider = ANY (ARRAY['wassenger'::text, 'telegram_bot_api'::text, 'meta'::text, 'twilio'::text, 'twochat'::text, 'wabridge'::text]));

CREATE TABLE IF NOT EXISTS public.wa_bridge_state (
  channel_id uuid PRIMARY KEY REFERENCES public.messaging_channels(id) ON DELETE CASCADE,
  last_heartbeat_at timestamptz,
  reachable boolean,
  connected boolean,
  logged_in boolean,
  bad_beats integer NOT NULL DEFAULT 0,
  alerted_state text,
  dropped_lid_count integer NOT NULL DEFAULT 0,
  last_dropped_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wa_bridge_state ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.wabridge_record_heartbeat(
  p_channel_id uuid, p_reachable boolean, p_connected boolean, p_logged_in boolean
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_healthy boolean := COALESCE(p_reachable, false) AND COALESCE(p_connected, false) AND COALESCE(p_logged_in, false);
BEGIN
  INSERT INTO wa_bridge_state (channel_id, last_heartbeat_at, reachable, connected, logged_in, bad_beats, updated_at)
  VALUES (p_channel_id, now(), p_reachable, p_connected, p_logged_in, CASE WHEN v_healthy THEN 0 ELSE 1 END, now())
  ON CONFLICT (channel_id) DO UPDATE SET
    last_heartbeat_at = now(),
    reachable = EXCLUDED.reachable,
    connected = EXCLUDED.connected,
    logged_in = EXCLUDED.logged_in,
    bad_beats = CASE WHEN v_healthy THEN 0 ELSE wa_bridge_state.bad_beats + 1 END,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_set_alerted(p_channel_id uuid, p_state text) RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  UPDATE wa_bridge_state SET alerted_state = p_state, updated_at = now() WHERE channel_id = p_channel_id;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_count_dropped(p_channel_id uuid) RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  INSERT INTO wa_bridge_state (channel_id, dropped_lid_count, last_dropped_at)
  VALUES (p_channel_id, 1, now())
  ON CONFLICT (channel_id) DO UPDATE SET
    dropped_lid_count = wa_bridge_state.dropped_lid_count + 1,
    last_dropped_at = now();
$$;

DROP FUNCTION IF EXISTS public.wabridge_ingest_message(uuid, uuid, text, text, text, text, text, text, timestamptz, jsonb);

CREATE OR REPLACE FUNCTION public.wabridge_ingest_message(
  p_group_id uuid,
  p_channel_id uuid,
  p_external_id text,
  p_direction text,
  p_sender_phone text,
  p_sender_name text,
  p_content_type text,
  p_content_text text,
  p_created_at timestamptz,
  p_metadata jsonb,
  p_backfill boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
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
    RETURN false; -- a legacy row already holds this message
  END IF;

  INSERT INTO messages (
    group_id, channel_id, external_message_id, direction, sender_phone, sender_name,
    content_type, content_text, status, created_at, metadata
  ) VALUES (
    p_group_id, p_channel_id, p_external_id, p_direction, p_sender_phone, p_sender_name,
    p_content_type, p_content_text,
    CASE WHEN p_direction = 'inbound' THEN (CASE WHEN p_backfill THEN 'read' ELSE 'new' END) ELSE 'responded' END,
    p_created_at, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false; -- already stored (redelivery / echo / history overlap): nothing else to change
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
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_record_heartbeat(uuid, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_record_heartbeat(uuid, boolean, boolean, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_set_alerted(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_set_alerted(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_count_dropped(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_count_dropped(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_ingest_message(uuid, uuid, text, text, text, text, text, text, timestamptz, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_ingest_message(uuid, uuid, text, text, text, text, text, text, timestamptz, jsonb, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_apply_names(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_apply_names(uuid, jsonb) TO service_role;
