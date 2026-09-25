-- WhatsApp bridge (dev job 907b2535, child e23343a6): reply from the CRM — STAGE 2 (the real sender's server side).
-- Requires 20260925-2000-wabridge-outbox.sql (wa_outbox, send_mode, send_allowlist, wabridge_enqueue_reply).
-- Antonio 2026-09-25 approved the pacing numbers: about a minute apart, at most 10 an hour and 40 a day (5 a day during the pilot),
-- at most 6 different people an hour, no identical text to more than 2 people an hour. Council-reviewed (system counselor, bug hunter,
-- AI architect, project director): the Mac's sender is its OWN job; a message the Mac cannot confirm is 'unknown' and NEVER retried
-- automatically (only a human resolves it); the CRM records a message as sent only when the Mac says it sent it.
--
-- State machine (wa_outbox.status): queued --claim--> unknown (claimed_at = now; the Mac is sending) --result ok--> sent | --result error--> failed.
-- 'unknown' older than ~2 minutes = the Mac never reported: shown as "Not confirmed — check the phone", blocks that chat's queue, and is resolved
-- by a person (mark sent / discard). A late "ok" from the Mac may still promote unknown -> sent; nothing ever returns to 'queued'.
-- No new CHECK constraints are added (the db-contract gate would flag them): the bounds live in the functions.
--
--   wa_bridge_state pacing columns   send_min_gap_seconds 60 | send_hourly_cap 10 | send_daily_cap 5 (PILOT — raise to 40 after the pilot) |
--                                    send_distinct_per_hour 6 | send_same_body_per_hour 2
--   wabridge_claim_send(channel)     ONE row per call, serialised by an advisory lock. Refuses (claimed:false, reason) when: not live (paused/test mode);
--                                    the bridge is unhealthy (no heartbeat within 6 min / not reachable / connected / logged in); another send is in
--                                    flight (< 120 s); the gap since the last send is too short; the hourly or daily cap is reached. Per candidate it
--                                    HOLDS (leaves queued) a reply whose chat has an unresolved 'unknown', that no longer has an inbound message,
--                                    that is off the allowlist, that would exceed the distinct-recipients-per-hour cap, or that is identical text
--                                    already sent to the maximum number of other people this hour. Queued replies older than 12 h are failed, never sent.
--   wabridge_finish_send(...)        the Mac's result. ok -> 'sent' + the outbound message row is created through wabridge_ingest_message from the id the
--                                    program returned ("TD Team"); error -> 'failed'. Idempotent; a discarded/failed row never flips to sent.
--   wabridge_resolve_outbox(...)     a person's decision on an 'unknown' row: 'sent' (records the message) or 'discard'. Refused while in flight.
--   wabridge_set_send_mode(...)      the pause switch. Refuses 'live' with an empty allowlist unless allow_all is true.
--   wabridge_set_send_allowlist(...) the digits allowed while live (normalised, junk dropped).
--
-- Sandbox: statement-by-statement via exec_sql. Production: Antonio runs it in the Supabase SQL editor.

ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS send_min_gap_seconds integer NOT NULL DEFAULT 60;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS send_hourly_cap integer NOT NULL DEFAULT 10;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS send_daily_cap integer NOT NULL DEFAULT 5;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS send_distinct_per_hour integer NOT NULL DEFAULT 6;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS send_same_body_per_hour integer NOT NULL DEFAULT 2;

CREATE OR REPLACE FUNCTION public.wabridge_claim_send(p_channel_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  s record;
  v_last timestamptz;
  v_gap integer;
  v_wait integer;
  v_hour_cap integer;
  v_day_cap integer;
  v_dist_cap integer;
  v_same_cap integer;
  v_hour integer;
  v_day integer;
  v_row record;
  v_held boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wabridge_claim:' || p_channel_id::text));

  SELECT * INTO s FROM wa_bridge_state WHERE channel_id = p_channel_id;
  IF NOT FOUND OR s.send_mode IS DISTINCT FROM 'live' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'paused'); -- fail closed: no row / test mode / paused
  END IF;
  IF s.last_heartbeat_at IS NULL OR s.last_heartbeat_at < now() - interval '6 minutes'
     OR s.reachable IS NOT TRUE OR s.connected IS NOT TRUE OR s.logged_in IS NOT TRUE THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'unhealthy');
  END IF;

  v_gap := LEAST(GREATEST(COALESCE(s.send_min_gap_seconds, 60), 30), 3600);
  v_hour_cap := LEAST(GREATEST(COALESCE(s.send_hourly_cap, 10), 1), 60);
  v_day_cap := LEAST(GREATEST(COALESCE(s.send_daily_cap, 5), 1), 200);
  v_dist_cap := LEAST(GREATEST(COALESCE(s.send_distinct_per_hour, 6), 1), 30);
  v_same_cap := LEAST(GREATEST(COALESCE(s.send_same_body_per_hour, 2), 1), 10);

  -- a reply that waited half a day is never sent
  UPDATE wa_outbox SET status = 'failed', error = 'expired before it could be sent'
  WHERE channel_id = p_channel_id AND status = 'queued' AND created_at < now() - interval '12 hours';

  IF EXISTS (SELECT 1 FROM wa_outbox WHERE channel_id = p_channel_id AND status = 'unknown' AND claimed_at > now() - interval '120 seconds') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'in_flight');
  END IF;

  SELECT max(claimed_at) INTO v_last FROM wa_outbox WHERE channel_id = p_channel_id AND status IN ('unknown', 'sent');
  IF v_last IS NOT NULL AND v_last > now() - make_interval(secs => v_gap) THEN
    v_wait := CEIL(EXTRACT(EPOCH FROM (v_last + make_interval(secs => v_gap) - now())));
    RETURN jsonb_build_object('claimed', false, 'reason', 'gap', 'wait_seconds', v_wait);
  END IF;

  SELECT count(*) INTO v_hour FROM wa_outbox
   WHERE channel_id = p_channel_id AND status IN ('unknown', 'sent') AND claimed_at > now() - interval '1 hour';
  IF v_hour >= v_hour_cap THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'hourly_cap');
  END IF;
  SELECT count(*) INTO v_day FROM wa_outbox
   WHERE channel_id = p_channel_id AND status IN ('unknown', 'sent') AND claimed_at > now() - interval '24 hours';
  IF v_day >= v_day_cap THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'daily_cap');
  END IF;

  FOR v_row IN
    SELECT o.* FROM wa_outbox o
    WHERE o.channel_id = p_channel_id AND o.status = 'queued'
    ORDER BY o.created_at
    FOR UPDATE SKIP LOCKED
  LOOP
    -- a chat with an unresolved 'unknown' is blocked until a person resolves it (never risk a double message)
    IF EXISTS (SELECT 1 FROM wa_outbox u WHERE u.group_id = v_row.group_id AND u.status = 'unknown' AND u.id <> v_row.id) THEN
      v_held := true; CONTINUE;
    END IF;
    -- reply-only, re-checked at send time
    IF NOT EXISTS (SELECT 1 FROM messages m WHERE m.group_id = v_row.group_id AND m.direction = 'inbound') THEN
      v_held := true; CONTINUE;
    END IF;
    IF COALESCE(cardinality(s.send_allowlist), 0) > 0 AND NOT (v_row.to_digits = ANY (s.send_allowlist)) THEN
      v_held := true; CONTINUE;
    END IF;
    -- at most N different people an hour (more replies to someone already messaged this hour are fine)
    IF (SELECT count(DISTINCT x.to_digits) FROM wa_outbox x
         WHERE x.channel_id = p_channel_id AND x.status IN ('unknown', 'sent') AND x.claimed_at > now() - interval '1 hour') >= v_dist_cap
       AND NOT EXISTS (SELECT 1 FROM wa_outbox x
         WHERE x.channel_id = p_channel_id AND x.status IN ('unknown', 'sent') AND x.claimed_at > now() - interval '1 hour' AND x.to_digits = v_row.to_digits) THEN
      v_held := true; CONTINUE;
    END IF;
    -- identical text to no more than N other people an hour
    IF (SELECT count(DISTINCT x.to_digits) FROM wa_outbox x
         WHERE x.channel_id = p_channel_id AND x.status IN ('unknown', 'sent') AND x.claimed_at > now() - interval '1 hour'
           AND lower(btrim(x.body)) = lower(btrim(v_row.body)) AND x.to_digits <> v_row.to_digits) >= v_same_cap THEN
      v_held := true; CONTINUE;
    END IF;

    UPDATE wa_outbox SET status = 'unknown', claimed_at = now() WHERE id = v_row.id;
    RETURN jsonb_build_object('claimed', true, 'id', v_row.id, 'to_digits', v_row.to_digits, 'body', v_row.body, 'group_id', v_row.group_id);
  END LOOP;

  RETURN jsonb_build_object('claimed', false, 'reason', CASE WHEN v_held THEN 'held' ELSE 'nothing_to_send' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_finish_send(
  p_channel_id uuid, p_outbox_id uuid, p_ok boolean, p_message_id text, p_error text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  o record;
BEGIN
  SELECT * INTO o FROM wa_outbox WHERE id = p_outbox_id AND channel_id = p_channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF o.status = 'sent' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', 'sent');
  END IF;
  -- only a message the Mac claimed can be finished; a row a person discarded (failed) never flips to sent
  IF o.status <> 'unknown' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_in_flight', 'status', o.status);
  END IF;

  IF p_ok THEN
    IF p_message_id IS NULL OR length(btrim(p_message_id)) < 6 OR length(p_message_id) > 200 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_message_id');
    END IF;
    UPDATE wa_outbox SET status = 'sent', sent_at = now(), external_message_id = btrim(p_message_id), error = NULL WHERE id = o.id;
    -- the program sends NO echo for API-sent messages, so the CRM records the message itself from the id it returned
    PERFORM wabridge_ingest_message(
      o.group_id, o.channel_id, btrim(p_message_id), 'outbound', NULL, 'TD Team', 'text', o.body, now(),
      jsonb_build_object('source', 'wabridge', 'sent_from', 'crm', 'outbox_id', o.id), false
    );
    RETURN jsonb_build_object('ok', true, 'status', 'sent');
  END IF;

  UPDATE wa_outbox SET status = 'failed', error = left(COALESCE(NULLIF(btrim(p_error), ''), 'send failed'), 500) WHERE id = o.id;
  RETURN jsonb_build_object('ok', true, 'status', 'failed');
END;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_resolve_outbox(p_outbox_id uuid, p_action text, p_user uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  o record;
BEGIN
  IF p_action NOT IN ('sent', 'discard') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_action', 'message', 'Unknown action.');
  END IF;
  SELECT * INTO o FROM wa_outbox WHERE id = p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'That message was not found.');
  END IF;
  IF o.status <> 'unknown' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_unconfirmed', 'message', 'That message is not waiting for a decision.');
  END IF;
  IF o.claimed_at > now() - interval '120 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'in_flight', 'message', 'It is being sent right now — wait a minute.');
  END IF;

  IF p_action = 'discard' THEN
    UPDATE wa_outbox SET status = 'failed', error = 'discarded by staff' WHERE id = o.id;
    RETURN jsonb_build_object('ok', true, 'status', 'failed');
  END IF;

  UPDATE wa_outbox SET status = 'sent', sent_at = now(), error = 'marked sent by staff' WHERE id = o.id;
  INSERT INTO messages (group_id, channel_id, direction, sender_name, content_type, content_text, status, created_at, metadata)
  VALUES (o.group_id, o.channel_id, 'outbound', 'TD Team', 'text', o.body, 'responded', now(),
          jsonb_build_object('source', 'crm_manual', 'outbox_id', o.id, 'resolved_by', p_user));
  UPDATE messaging_groups SET last_message_at = GREATEST(COALESCE(last_message_at, now()), now()), updated_at = now() WHERE id = o.group_id;
  RETURN jsonb_build_object('ok', true, 'status', 'sent');
END;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_set_send_mode(p_channel_id uuid, p_mode text, p_allow_all boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_allow text[];
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('paused', 'shadow', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_mode', 'message', 'Unknown mode.');
  END IF;
  SELECT send_allowlist INTO v_allow FROM wa_bridge_state WHERE channel_id = p_channel_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'This line has no bridge state yet.');
  END IF;
  IF p_mode = 'live' AND COALESCE(cardinality(v_allow), 0) = 0 AND p_allow_all IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'code', 'needs_allowlist', 'message', 'Going live needs a list of allowed numbers first (or an explicit "everyone").');
  END IF;
  UPDATE wa_bridge_state SET send_mode = p_mode, updated_at = now() WHERE channel_id = p_channel_id;
  RETURN jsonb_build_object('ok', true, 'mode', p_mode);
END;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_set_send_allowlist(p_channel_id uuid, p_digits text[]) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean text[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT d), '{}') INTO v_clean
  FROM (SELECT regexp_replace(x, '\D', '', 'g') AS d FROM unnest(COALESCE(p_digits, '{}')) AS x) t
  WHERE length(d) BETWEEN 6 AND 15;
  UPDATE wa_bridge_state SET send_allowlist = v_clean, updated_at = now() WHERE channel_id = p_channel_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'This line has no bridge state yet.');
  END IF;
  RETURN jsonb_build_object('ok', true, 'count', COALESCE(cardinality(v_clean), 0));
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_claim_send(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_claim_send(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_finish_send(uuid, uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_finish_send(uuid, uuid, boolean, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_resolve_outbox(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_resolve_outbox(uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_set_send_mode(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_set_send_mode(uuid, text, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_set_send_allowlist(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_set_send_allowlist(uuid, text[]) TO service_role;
