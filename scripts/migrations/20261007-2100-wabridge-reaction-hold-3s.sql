-- WhatsApp reactions CRM -> phone: the undo window is now 3 seconds and lives in a column (dev job 5962e46d, Release 2 follow-up).
-- Antonio 2026-10-07 (option 2): "the message be pushed right away instead of after seconds" -> shorten the 10 s undo hold to 3 s.
-- Why a column: like the pacing gap and the caps (reactions_min_gap_seconds ...), the window can be tuned with one UPDATE, no deploy and no
-- migration: UPDATE wa_bridge_state SET reactions_hold_seconds = 0 (instant, no undo) .. 30. The function clamps it to 0..30 and the answer
-- carries the value used (hold_seconds), which the screen already reads.
-- Only wabridge_queue_phone_reaction changes (the body below is the 20261007-1600 body with the three fixed '10 seconds' replaced). Nothing else.
-- No value-list CHECK constraint (db-contract gate): the clamp inside the function is the rule.

ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS reactions_hold_seconds integer NOT NULL DEFAULT 3;

-- ── Queue (called by wabridge_react_click after the team mark is saved) ──────────────────────────────────────────────
-- p_action 'set'    → the phone should show p_emoji (latest pick wins, replacing whatever is there). Picking again an emoji whose send FAILED or
--                     EXPIRED is a retry.
-- p_action 'remove' → the staff member un-picked p_emoji: if it is the emoji ON the phone it is taken off; if it was a pick that has not
--                     gone out yet it is simply dropped (the phone keeps what it shows); any other emoji changes nothing.
-- Returns { ok:true, queued:true, id, status:'pending', hold_seconds } | { ok:true, queued:false, reason } | { ok:false, code }.
CREATE OR REPLACE FUNCTION public.wabridge_queue_phone_reaction(
  p_message_id uuid, p_emoji text, p_action text, p_user uuid
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  m record;
  s record;
  v_emoji text := btrim(COALESCE(p_emoji, ''));
  v_norm text;
  v_digits text;
  v_phone text;          -- what the phone shows (the 'line' element)
  v_cur text;            -- what the phone is about to show
  v_desired text;
  v_lane record;
  v_force boolean := false;
  v_id uuid;
  v_hold integer;        -- the undo window in seconds (wa_bridge_state.reactions_hold_seconds)
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('set', 'remove') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_request');
  END IF;
  v_norm := replace(v_emoji, chr(65039), '');
  IF v_emoji = '' OR char_length(v_emoji) > 32 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_request');
  END IF;

  -- lock order everywhere in this feature: the MESSAGE row first, then the lane row
  SELECT msg.id, msg.group_id, msg.channel_id, msg.external_message_id, msg.created_at, msg.deleted_at,
         COALESCE(msg.reactions, '[]'::jsonb) AS reactions,
         g.external_group_id, g.is_active AS group_active, c.provider, c.is_active AS channel_active
    INTO m
    FROM messages msg
    JOIN messaging_groups g ON g.id = msg.group_id
    JOIN messaging_channels c ON c.id = msg.channel_id
   WHERE msg.id = p_message_id
   FOR UPDATE OF msg;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  SELECT * INTO s FROM wa_bridge_state WHERE channel_id = m.channel_id;
  IF NOT FOUND OR s.reactions_mode IS DISTINCT FROM 'live' THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'off'); -- fail closed: no state row / off
  END IF;
  v_hold := GREATEST(0, LEAST(30, COALESCE(s.reactions_hold_seconds, 3)));

  IF m.provider IS DISTINCT FROM 'wabridge' OR m.channel_active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'not_wabridge');
  END IF;
  IF m.group_active IS NOT TRUE OR m.external_group_id !~ '^[0-9]{6,15}(@(s\.whatsapp\.net|c\.us))?$' THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'not_one_to_one');
  END IF;
  v_digits := regexp_replace(m.external_group_id, '@.*$', '');

  IF NOT (COALESCE(s.reactions_allow_all, false) OR v_digits = ANY (COALESCE(s.reactions_allowlist, '{}'::text[]))) THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'not_allowed');
  END IF;

  IF m.deleted_at IS NOT NULL OR m.external_message_id IS NULL OR m.external_message_id !~ '^[A-Za-z0-9]{4,64}$' THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'no_message_id');
  END IF;
  -- replies only: the person must have written to this number at least once (history counts) — same rule as text replies
  IF NOT EXISTS (SELECT 1 FROM messages x WHERE x.group_id = m.group_id AND x.direction = 'inbound' AND x.deleted_at IS NULL) THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'no_inbound');
  END IF;
  -- the 1-hour limit applies to putting a reaction ON, never to taking one off
  IF p_action = 'set' AND m.created_at < now() - interval '1 hour' THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'too_old');
  END IF;
  IF p_action = 'set' AND NOT wabridge_react_safe_emoji(v_emoji) THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'bad_emoji');
  END IF;
  IF s.last_heartbeat_at IS NULL OR s.last_heartbeat_at < now() - interval '3 minutes'
     OR s.reachable IS NOT TRUE OR s.connected IS NOT TRUE OR s.logged_in IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'offline');
  END IF;
  -- the Mac reaction sender must be running — otherwise a pick would sit on screen as "sending…" and expire
  IF s.reactions_sender_seen_at IS NULL OR s.reactions_sender_seen_at < now() - interval '3 minutes' THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'sender_offline');
  END IF;

  -- the heart is always sent with its variation selector (a bare U+2764 can render as a text-style heart)
  IF v_norm = '❤' THEN v_emoji := '❤️'; END IF;

  v_phone := wabridge_react_line_emoji(m.reactions);
  SELECT * INTO v_lane FROM wa_reaction_sync WHERE message_id = m.id FOR UPDATE;
  IF v_lane.id IS NOT NULL AND v_lane.status IN ('pending', 'sending') THEN
    v_cur := v_lane.desired_emoji;
  ELSE
    v_cur := v_phone;
  END IF;

  IF p_action = 'remove' THEN
    IF replace(COALESCE(v_cur, ''), chr(65039), '') IS DISTINCT FROM v_norm THEN
      RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'unchanged');
    END IF;
    IF replace(COALESCE(v_cur, ''), chr(65039), '') IS DISTINCT FROM replace(COALESCE(v_phone, ''), chr(65039), '') THEN
      v_desired := COALESCE(v_phone, ''); -- UNDO of a pick that has not gone out: back to what the phone shows — never remove what is really there
    ELSE
      v_desired := '';                   -- the emoji IS on the phone: take it off
    END IF;
  ELSE
    v_desired := v_emoji;
    -- picking again an emoji whose send FAILED or EXPIRED is a retry (idempotent on WhatsApp), even if the CRM believes it is not there
    IF v_lane.id IS NOT NULL AND v_lane.status IN ('failed', 'expired')
       AND replace(v_lane.desired_emoji, chr(65039), '') = replace(v_emoji, chr(65039), '') THEN
      v_force := true;
    END IF;
  END IF;

  IF replace(v_desired, chr(65039), '') = replace(COALESCE(v_phone, ''), chr(65039), '') AND NOT v_force THEN
    -- the phone already shows exactly this (or the pick was undone before it was sent): nothing to send
    IF v_lane.id IS NOT NULL THEN
      IF v_lane.status = 'sending' THEN
        -- mid-flight: remember the new intent, and give it its own undo window (finish() re-queues it)
        UPDATE wa_reaction_sync SET desired_emoji = v_desired, hold_until = now() + make_interval(secs => v_hold) WHERE id = v_lane.id;
      ELSIF v_lane.status IN ('pending', 'failed', 'expired') THEN
        UPDATE wa_reaction_sync SET desired_emoji = v_desired, status = 'cancelled', finished_at = now(), error = NULL WHERE id = v_lane.id;
      END IF;
    END IF;
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'unchanged');
  END IF;

  IF v_lane.id IS NULL THEN
    INSERT INTO wa_reaction_sync (channel_id, group_id, message_id, external_message_id, to_digits, desired_emoji, applied_emoji, status, requested_by, hold_until)
    VALUES (m.channel_id, m.group_id, m.id, m.external_message_id, v_digits, v_desired, COALESCE(v_phone, ''), 'pending', p_user, now() + make_interval(secs => v_hold))
    RETURNING id INTO v_id;
  ELSE
    -- a lane row mid-flight keeps 'sending'; finish() sees the changed intent and re-queues. Otherwise (re)start the hold.
    UPDATE wa_reaction_sync SET
      desired_emoji = v_desired,
      applied_emoji = COALESCE(v_phone, ''),
      status = CASE WHEN status = 'sending' THEN 'sending' ELSE 'pending' END,
      requested_by = p_user, requested_at = now(), hold_until = now() + make_interval(secs => v_hold),
      attempts = CASE WHEN status = 'sending' THEN attempts ELSE 0 END,
      error = NULL, finished_at = NULL
     WHERE id = v_lane.id
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'queued', true, 'id', v_id, 'status', 'pending', 'hold_seconds', v_hold);
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_queue_phone_reaction(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_queue_phone_reaction(uuid, text, text, uuid) TO service_role;
