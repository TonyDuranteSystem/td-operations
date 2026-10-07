-- WhatsApp reactions made IN THE CRM → the customer's phone (dev job 5962e46d, Release 2; Release 1 = phone → CRM, already live).
--
-- Antonio 2026-10-06: "if I send the reaction from the CRM it must appear on the phone and vice versa."
-- Decisions 2026-10-07: (1) WhatsApp allows ONE reaction per person per message, so the LATEST CRM pick is what the phone shows
-- (every team member's mark stays visible in the CRM); (2) a message can only be reacted to for 1 HOUR after it arrived/was sent.
--
-- HOW IT WORKS
--   staff click an emoji on a WhatsApp message → the CRM saves the team mark (wabridge_toggle_reaction, unchanged) → then calls
--   wabridge_queue_phone_reaction(), which — only if every gate below passes — writes ONE row per message into wa_reaction_sync:
--   "the phone should show X" (desired_emoji; '' = no reaction). The row waits HOLD seconds (10) so Undo is real (clicking the same
--   emoji again, or picking another, just updates the row). A SEPARATE Mac sender (not send-loop.sh) claims due rows one at a time
--   (wabridge_claim_reaction), calls the WhatsApp program's reaction endpoint, and reports (wabridge_finish_reaction). Success writes
--   the message's 'line' element in messages.reactions (the green "phone" pill, source 'crm') — the program keeps NO record of
--   reactions sent through its API, so this CRM row is the only memory of what we put there.
--
-- GATES (all server-side, in order; any failure → the CRM mark is still saved, nothing is queued, the screen says why):
--   switch  wa_bridge_state.reactions_mode must be 'live'  (DEFAULT 'off' — fail closed; separate from the reply switch)
--   allow   reactions_allow_all, or the chat's number on reactions_allowlist  (DEFAULT: nobody)
--   health  the bridge is reachable + connected + logged in with a heartbeat < 3 min
--   chat    a real 1:1 phone chat on an ACTIVE 'wabridge' channel, message not hidden, message has the program's id
--   age     the message is at most 1 hour old
--   emoji   one of the safe set below (WhatsApp's own quick reactions + a few we use); anything else stays CRM-only
-- At claim time the Mac also needs: the phone→CRM reader alive (reactions_seen_at < 3 min), the pacing gap, hourly/daily and
-- per-chat caps. A queued reaction that waits more than 15 minutes expires (never a surprise reaction hours later).
-- A reaction is idempotent on WhatsApp's side, so a send whose answer was lost is simply retried (max 3 attempts).
--
-- No value-list CHECK constraints (the db-contract gate): every rule is enforced inside the functions.

ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS reactions_mode text NOT NULL DEFAULT 'off';
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS reactions_allowlist text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS reactions_allow_all boolean NOT NULL DEFAULT false;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS reactions_min_gap_seconds integer NOT NULL DEFAULT 4;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS reactions_hourly_cap integer NOT NULL DEFAULT 40;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS reactions_daily_cap integer NOT NULL DEFAULT 200;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS reactions_per_chat_hour integer NOT NULL DEFAULT 12;

CREATE TABLE IF NOT EXISTS public.wa_reaction_sync (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.messaging_channels(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.messaging_groups(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  external_message_id text NOT NULL,
  to_digits text NOT NULL,
  desired_emoji text NOT NULL DEFAULT '',   -- what the phone should show; '' = no reaction
  applied_emoji text NOT NULL DEFAULT '',   -- what we last confirmed on the phone; '' = none
  sent_emoji text,                          -- the value handed to the Mac on the current claim
  status text NOT NULL,                     -- pending | sending | sent | failed | expired | cancelled (enforced in the functions)
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  hold_until timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  CONSTRAINT wa_reaction_sync_message_key UNIQUE (message_id)
);
CREATE INDEX IF NOT EXISTS wa_reaction_sync_channel_status_idx ON public.wa_reaction_sync (channel_id, status, requested_at);
CREATE INDEX IF NOT EXISTS wa_reaction_sync_group_idx ON public.wa_reaction_sync (group_id, requested_at DESC);
ALTER TABLE public.wa_reaction_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wa_reaction_sync FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.wa_reaction_sync TO service_role;

-- The emoji the CRM may put on a customer's phone. Compared WITHOUT the emoji variation selector (U+FE0F).
-- MUST stay equal to PHONE_SAFE_EMOJI in lib/messaging/wabridge-react.ts (a unit test reads this file and compares them).
CREATE OR REPLACE FUNCTION public.wabridge_react_safe_emoji(p_emoji text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT replace(COALESCE(p_emoji, ''), chr(65039), '') = ANY (ARRAY['👍','❤','😂','😮','😢','🙏','🤝','👏','✅','🔥','🎉','🔝'])
$$;

-- ── Queue (called by the staff react route after the team mark is saved) ─────────────────────────────────────────────
-- p_action 'set'    → the phone should show p_emoji (latest pick wins, replacing whatever we put there before)
-- p_action 'remove' → the staff member un-picked p_emoji: if it is the emoji ON the phone it is taken off; if it was a pick that has not gone out
--                    yet it is simply dropped (the phone keeps showing what it already shows); any other emoji changes nothing
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
  v_line_emoji text := '';
  v_cur text;
  v_desired text;
  v_applied text;
  v_lane record;
  v_id uuid;
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
  IF m.created_at < now() - interval '1 hour' THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'too_old');
  END IF;
  IF p_action = 'set' AND NOT wabridge_react_safe_emoji(v_emoji) THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'bad_emoji');
  END IF;
  IF s.last_heartbeat_at IS NULL OR s.last_heartbeat_at < now() - interval '3 minutes'
     OR s.reachable IS NOT TRUE OR s.connected IS NOT TRUE OR s.logged_in IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'offline');
  END IF;

  -- what the phone shows now (as far as we know): the lane's own intent if there is one, else the message's 'line' element
  SELECT COALESCE(e->>'emoji', '') INTO v_line_emoji
    FROM jsonb_array_elements(m.reactions) e WHERE e->>'reactor_type' = 'line' LIMIT 1;
  v_line_emoji := COALESCE(v_line_emoji, '');

  SELECT * INTO v_lane FROM wa_reaction_sync WHERE message_id = m.id FOR UPDATE;
  IF v_lane.id IS NOT NULL THEN
    v_cur := CASE WHEN v_lane.status IN ('pending', 'sending') THEN v_lane.desired_emoji ELSE v_lane.applied_emoji END;
    v_applied := v_lane.applied_emoji;
  ELSE
    v_cur := v_line_emoji;
    v_applied := v_line_emoji;
  END IF;

  IF p_action = 'remove' THEN
    -- un-picking an emoji that is not the one the phone is (about to be) showing changes nothing on the phone
    IF replace(COALESCE(v_cur, ''), chr(65039), '') IS DISTINCT FROM v_norm THEN
      RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'unchanged');
    END IF;
    IF replace(COALESCE(v_cur, ''), chr(65039), '') IS DISTINCT FROM replace(COALESCE(v_applied, ''), chr(65039), '') THEN
      -- UNDO of a pick that has not gone out yet: go back to what the phone already shows — never remove what is really there
      v_desired := COALESCE(v_applied, '');
    ELSE
      v_desired := ''; -- the emoji IS on the phone: take it off
    END IF;
  ELSE
    v_desired := v_emoji;
  END IF;

  IF replace(v_desired, chr(65039), '') = replace(COALESCE(v_applied, ''), chr(65039), '') THEN
    -- the phone already shows exactly this (or the pick was undone before it was sent): nothing to send
    IF v_lane.id IS NOT NULL THEN
      UPDATE wa_reaction_sync SET desired_emoji = v_desired, status = CASE WHEN status IN ('pending') THEN 'cancelled' ELSE status END,
             finished_at = CASE WHEN status = 'pending' THEN now() ELSE finished_at END
       WHERE id = v_lane.id;
    END IF;
    RETURN jsonb_build_object('ok', true, 'queued', false, 'reason', 'unchanged');
  END IF;

  IF v_lane.id IS NULL THEN
    INSERT INTO wa_reaction_sync (channel_id, group_id, message_id, external_message_id, to_digits, desired_emoji, applied_emoji, status, requested_by, hold_until)
    VALUES (m.channel_id, m.group_id, m.id, m.external_message_id, v_digits, v_desired, COALESCE(v_applied, ''), 'pending', p_user, now() + interval '10 seconds')
    RETURNING id INTO v_id;
  ELSE
    -- a lane row mid-flight keeps 'sending'; finish() sees the changed intent and re-queues. Otherwise (re)start the hold.
    UPDATE wa_reaction_sync SET
      desired_emoji = v_desired,
      status = CASE WHEN status = 'sending' THEN 'sending' ELSE 'pending' END,
      requested_by = p_user, requested_at = now(), hold_until = now() + interval '10 seconds',
      attempts = CASE WHEN status = 'sending' THEN attempts ELSE 0 END,
      error = NULL, finished_at = NULL
     WHERE id = v_lane.id
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'queued', true, 'id', v_id, 'status', 'pending', 'hold_seconds', 10);
END;
$$;

-- ── Claim (the Mac sender asks for the next due reaction; at most ONE per call, serialised) ─────────────────────────
CREATE OR REPLACE FUNCTION public.wabridge_claim_reaction(p_channel_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  s record;
  v_row record;
  v_last timestamptz;
  v_gap integer;
  v_wait integer;
  v_hour_cap integer;
  v_day_cap integer;
  v_chat_cap integer;
  v_held boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wabridge_react_claim:' || p_channel_id::text));

  SELECT * INTO s FROM wa_bridge_state WHERE channel_id = p_channel_id;
  IF NOT FOUND OR s.reactions_mode IS DISTINCT FROM 'live' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'paused');
  END IF;
  IF s.last_heartbeat_at IS NULL OR s.last_heartbeat_at < now() - interval '3 minutes'
     OR s.reachable IS NOT TRUE OR s.connected IS NOT TRUE OR s.logged_in IS NOT TRUE THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'unhealthy');
  END IF;
  -- the phone → CRM reader must be alive: it is the only thing that notices a change made natively on the phone
  IF s.reactions_seen_at IS NULL OR s.reactions_seen_at < now() - interval '3 minutes' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'reader_stale');
  END IF;

  v_gap := LEAST(GREATEST(COALESCE(s.reactions_min_gap_seconds, 4), 2), 600);
  v_hour_cap := LEAST(GREATEST(COALESCE(s.reactions_hourly_cap, 40), 1), 200);
  v_day_cap := LEAST(GREATEST(COALESCE(s.reactions_daily_cap, 200), 1), 1000);
  v_chat_cap := LEAST(GREATEST(COALESCE(s.reactions_per_chat_hour, 12), 1), 60);

  -- housekeeping: a reaction that waited more than 15 minutes never goes out; a claim the Mac never answered is retried (a reaction is
  -- idempotent on WhatsApp) up to 3 attempts, then reported failed
  UPDATE wa_reaction_sync SET status = 'expired', finished_at = now(), error = 'not sent — the WhatsApp link was busy or offline for too long'
   WHERE channel_id = p_channel_id AND status = 'pending' AND requested_at < now() - interval '15 minutes';
  UPDATE wa_reaction_sync SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
         error = CASE WHEN attempts >= 3 THEN 'no answer from the WhatsApp program' ELSE error END,
         finished_at = CASE WHEN attempts >= 3 THEN now() ELSE finished_at END
   WHERE channel_id = p_channel_id AND status = 'sending' AND claimed_at < now() - interval '2 minutes';

  IF EXISTS (SELECT 1 FROM wa_reaction_sync WHERE channel_id = p_channel_id AND status = 'sending' AND claimed_at >= now() - interval '2 minutes') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'in_flight');
  END IF;

  SELECT max(claimed_at) INTO v_last FROM wa_reaction_sync WHERE channel_id = p_channel_id AND claimed_at IS NOT NULL;
  IF v_last IS NOT NULL AND v_last > now() - make_interval(secs => v_gap) THEN
    v_wait := CEIL(EXTRACT(EPOCH FROM (v_last + make_interval(secs => v_gap) - now())));
    RETURN jsonb_build_object('claimed', false, 'reason', 'gap', 'wait_seconds', v_wait);
  END IF;

  IF (SELECT count(*) FROM wa_reaction_sync WHERE channel_id = p_channel_id AND claimed_at > now() - interval '1 hour') >= v_hour_cap THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'hourly_cap');
  END IF;
  IF (SELECT count(*) FROM wa_reaction_sync WHERE channel_id = p_channel_id AND claimed_at > now() - interval '24 hours') >= v_day_cap THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'daily_cap');
  END IF;

  FOR v_row IN
    SELECT r.* FROM wa_reaction_sync r
     WHERE r.channel_id = p_channel_id AND r.status = 'pending' AND r.hold_until <= now()
     ORDER BY r.requested_at
     FOR UPDATE SKIP LOCKED
  LOOP
    -- the switch / allowlist are re-checked at send time (they may have changed while the reaction waited)
    IF NOT (COALESCE(s.reactions_allow_all, false) OR v_row.to_digits = ANY (COALESCE(s.reactions_allowlist, '{}'::text[]))) THEN
      v_held := true; CONTINUE;
    END IF;
    -- nothing to do if the phone already shows the wanted value
    IF replace(v_row.desired_emoji, chr(65039), '') = replace(v_row.applied_emoji, chr(65039), '') THEN
      UPDATE wa_reaction_sync SET status = 'cancelled', finished_at = now() WHERE id = v_row.id;
      CONTINUE;
    END IF;
    IF (SELECT count(*) FROM wa_reaction_sync x WHERE x.group_id = v_row.group_id AND x.claimed_at > now() - interval '1 hour') >= v_chat_cap THEN
      v_held := true; CONTINUE;
    END IF;

    UPDATE wa_reaction_sync SET status = 'sending', claimed_at = now(), attempts = attempts + 1, sent_emoji = desired_emoji WHERE id = v_row.id;
    RETURN jsonb_build_object('claimed', true, 'id', v_row.id, 'to_digits', v_row.to_digits,
                              'external_message_id', v_row.external_message_id, 'emoji', v_row.desired_emoji);
  END LOOP;

  RETURN jsonb_build_object('claimed', false, 'reason', CASE WHEN v_held THEN 'held' ELSE 'nothing_to_send' END);
END;
$$;

-- ── Finish (the Mac's result for one claim) ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wabridge_finish_reaction(
  p_channel_id uuid, p_id uuid, p_ok boolean, p_error text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_msg uuid;
  v_lane record;
  v_reactions jsonb;
  v_idx int;
  v_new jsonb;
  v_sent text;
  v_scan bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  -- lock order: the MESSAGE row first (found through the lane row, unlocked), then the lane row
  SELECT message_id INTO v_msg FROM wa_reaction_sync WHERE id = p_id AND channel_id = p_channel_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  SELECT COALESCE(reactions, '[]'::jsonb) INTO v_reactions FROM messages WHERE id = v_msg FOR UPDATE;
  SELECT * INTO v_lane FROM wa_reaction_sync WHERE id = p_id AND channel_id = p_channel_id FOR UPDATE;

  IF v_lane.status IS DISTINCT FROM 'sending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_in_flight', 'status', v_lane.status);
  END IF;
  v_sent := COALESCE(v_lane.sent_emoji, '');

  IF NOT p_ok THEN
    UPDATE wa_reaction_sync SET status = 'failed', finished_at = now(),
           error = left(COALESCE(NULLIF(btrim(p_error), ''), 'the WhatsApp program refused the reaction'), 300)
     WHERE id = v_lane.id;
    RETURN jsonb_build_object('ok', true, 'status', 'failed');
  END IF;

  -- success: remember what is now on the phone, and show it as the green "phone" pill (source 'crm')
  SELECT (t.ord - 1)::int INTO v_idx
    FROM jsonb_array_elements(v_reactions) WITH ORDINALITY AS t(elem, ord)
   WHERE t.elem->>'reactor_type' = 'line' LIMIT 1;
  v_new := jsonb_build_object(
    'emoji', v_sent,
    'reactor_id', 'wa-line',
    'reactor_type', 'line',
    'reactor_name', NULL,
    'created_at', to_jsonb(now()),
    'scan_ms', v_scan,
    'source', 'crm'
  );
  IF v_sent = '' THEN
    v_new := v_new || jsonb_build_object('removed_at', to_jsonb(now())); -- a tombstone: the reaction was taken off the phone
  END IF;
  IF v_idx IS NULL THEN
    IF v_sent <> '' THEN v_reactions := v_reactions || jsonb_build_array(v_new); END IF;
  ELSE
    v_reactions := jsonb_set(v_reactions, ARRAY[v_idx::text], v_new);
  END IF;
  UPDATE messages SET reactions = v_reactions WHERE id = v_msg;

  IF replace(v_lane.desired_emoji, chr(65039), '') = replace(v_sent, chr(65039), '') THEN
    UPDATE wa_reaction_sync SET status = 'sent', applied_emoji = v_sent, finished_at = now(), error = NULL WHERE id = v_lane.id;
    RETURN jsonb_build_object('ok', true, 'status', 'sent');
  END IF;
  -- the pick changed while this one was in flight: it is on the phone now, and the newer pick waits its own hold
  UPDATE wa_reaction_sync SET status = 'pending', applied_emoji = v_sent, finished_at = NULL, attempts = 0, error = NULL WHERE id = v_lane.id;
  RETURN jsonb_build_object('ok', true, 'status', 'pending');
END;
$$;

-- ── Owner switches (service role only; the route that calls them checks the OWNER) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.wabridge_set_reactions_mode(p_channel_id uuid, p_mode text, p_allow_all boolean DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  s record;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('off', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_mode');
  END IF;
  SELECT * INTO s FROM wa_bridge_state WHERE channel_id = p_channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  -- going live with nobody on the list and "everyone" off would be a switch that does nothing — refuse, say why
  IF p_mode = 'live' AND COALESCE(cardinality(s.reactions_allowlist), 0) = 0 AND COALESCE(p_allow_all, s.reactions_allow_all, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'code', 'empty_allowlist');
  END IF;
  UPDATE wa_bridge_state SET reactions_mode = p_mode, reactions_allow_all = COALESCE(p_allow_all, reactions_allow_all), updated_at = now()
   WHERE channel_id = p_channel_id;
  RETURN jsonb_build_object('ok', true, 'mode', p_mode);
END;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_set_reactions_allowlist(p_channel_id uuid, p_digits text[]) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean text[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT d), '{}'::text[]) INTO v_clean
    FROM (SELECT regexp_replace(x, '\D', '', 'g') AS d FROM unnest(COALESCE(p_digits, '{}'::text[])) AS x) q
   WHERE d ~ '^[0-9]{6,15}$';
  UPDATE wa_bridge_state SET reactions_allowlist = v_clean, updated_at = now() WHERE channel_id = p_channel_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  RETURN jsonb_build_object('ok', true, 'allowlist', to_jsonb(v_clean));
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_react_safe_emoji(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wabridge_queue_phone_reaction(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wabridge_claim_reaction(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wabridge_finish_reaction(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wabridge_set_reactions_mode(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wabridge_set_reactions_allowlist(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_react_safe_emoji(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wabridge_queue_phone_reaction(uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.wabridge_claim_reaction(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.wabridge_finish_reaction(uuid, uuid, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wabridge_set_reactions_mode(uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.wabridge_set_reactions_allowlist(uuid, text[]) TO service_role;
