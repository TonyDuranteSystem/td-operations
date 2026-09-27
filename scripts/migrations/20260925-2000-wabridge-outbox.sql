-- WhatsApp bridge (dev job 907b2535, child e23343a6): reply from the CRM — STAGE 1 (enqueue side + "test mode").
-- Antonio 2026-09-25: replies ONLY (first contact stays on the phone), no time window ("why 24 hours? no timing"), messages show
-- as "TD Team" (no personal name), pause switch OFF by default, avoid any ban, at-most-once (never risk messaging a lead twice).
-- Council-reviewed (system counselor, bug hunter, AI architect, project director).
--
-- Stage 1 records what WOULD be sent and sends NOTHING (send_mode 'shadow'); the Mac-side sender, the claim/result functions and
-- real sending are STAGE 2 (after the Mac restart test) — deliberately not in this file.
--
--   wa_bridge_state.send_mode      'paused' (DEFAULT — fail closed: an unreadable/missing value means paused) | 'shadow' | 'live'
--   wa_bridge_state.send_allowlist digits of the only numbers allowed while 'live' (empty = no allowlist). Stage-2 pilot = Antonio's own numbers.
--   wa_outbox                      one row per reply: shadow | queued | sent | failed | unknown. RLS on, NO policies (service_role only).
--                                  A row is NEVER returned to 'queued' automatically; 'unknown' is resolved by a human.
--   wabridge_enqueue_reply()       the ONLY writer of new rows. Server-side rules, in this order:
--                                  chat exists + is active + belongs to an ACTIVE 'wabridge' channel; the chat key is a real 1:1 phone
--                                  (digits, optional @c.us — never @g.us groups / @lid / junk); body 1..4096 chars after trim;
--                                  idempotent on (channel, client_msg_id) BEFORE the mode checks (a retry returns the same row);
--                                  mode paused -> refused; REPLY-ONLY: the chat must contain at least one inbound message from the person
--                                  (history counts — no time window); 'live' + allowlist -> number must be on it.
--                                  Returns jsonb {ok, id, status, duplicate?} or {ok:false, code, message}.
--
-- Sandbox: statement-by-statement via exec_sql. Production: Antonio runs it in the Supabase SQL editor.

ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS send_mode text NOT NULL DEFAULT 'paused';
ALTER TABLE public.wa_bridge_state DROP CONSTRAINT IF EXISTS wa_bridge_state_send_mode_check;
ALTER TABLE public.wa_bridge_state ADD CONSTRAINT wa_bridge_state_send_mode_check CHECK (send_mode IN ('paused', 'shadow', 'live'));
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS send_allowlist text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS public.wa_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.messaging_channels(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.messaging_groups(id) ON DELETE CASCADE,
  to_digits text NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4096),
  client_msg_id text NOT NULL CHECK (length(client_msg_id) BETWEEN 8 AND 100),
  status text NOT NULL CHECK (status IN ('shadow', 'queued', 'sent', 'failed', 'unknown')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  external_message_id text,
  error text,
  CONSTRAINT wa_outbox_channel_client_msg_key UNIQUE (channel_id, client_msg_id)
);

CREATE INDEX IF NOT EXISTS wa_outbox_group_created_idx ON public.wa_outbox (group_id, created_at);
CREATE INDEX IF NOT EXISTS wa_outbox_channel_status_idx ON public.wa_outbox (channel_id, status, created_at);

ALTER TABLE public.wa_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wa_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.wa_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.wabridge_enqueue_reply(
  p_group_id uuid, p_body text, p_client_msg_id text, p_created_by uuid
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
  v_body text := btrim(COALESCE(p_body, ''));
  v_mode text;
  v_allow text[];
  v_existing record;
  v_id uuid;
  v_status text;
BEGIN
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

  -- a real 1:1 phone chat only: digits (6-15) with an optional @c.us — never a group, @lid or junk key
  IF v_key !~ '^[0-9]{6,15}(@c\.us)?$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_one_to_one', 'message', 'Replies can only be sent to one-to-one chats.');
  END IF;
  v_digits := regexp_replace(v_key, '\D', '', 'g');

  IF v_body = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'empty', 'message', 'Type a message first.');
  END IF;
  IF length(v_body) > 4096 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_long', 'message', 'That message is too long (4096 characters maximum).');
  END IF;
  IF p_client_msg_id IS NULL OR length(p_client_msg_id) < 8 OR length(p_client_msg_id) > 100 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_request', 'message', 'Missing message id — please reload the page and try again.');
  END IF;

  -- a retry (double click, two tabs, network timeout) returns the SAME row, before any mode check
  SELECT o.id, o.status INTO v_existing FROM wa_outbox o WHERE o.channel_id = v_channel AND o.client_msg_id = p_client_msg_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
  END IF;

  -- FAIL CLOSED: no state row / no readable mode = paused
  SELECT s.send_mode, s.send_allowlist INTO v_mode, v_allow FROM wa_bridge_state s WHERE s.channel_id = v_channel;
  IF NOT FOUND OR v_mode IS NULL OR v_mode NOT IN ('shadow', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'paused', 'message', 'Sending from the CRM is paused — reply from the phone for now.');
  END IF;

  -- REPLY-ONLY: the person must have written to this number at some point (history counts; no time window)
  IF NOT EXISTS (SELECT 1 FROM messages m WHERE m.group_id = p_group_id AND m.direction = 'inbound') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'no_inbound', 'message', 'You can only reply to people who have written to this number. First contact is made from the phone.');
  END IF;

  IF v_mode = 'live' AND COALESCE(cardinality(v_allow), 0) > 0 AND NOT (v_digits = ANY (v_allow)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_allowed', 'message', 'Sending is limited to test numbers right now.');
  END IF;

  v_status := CASE WHEN v_mode = 'live' THEN 'queued' ELSE 'shadow' END;
  INSERT INTO wa_outbox (channel_id, group_id, to_digits, body, client_msg_id, status, created_by)
  VALUES (v_channel, p_group_id, v_digits, v_body, p_client_msg_id, v_status, p_created_by)
  ON CONFLICT (channel_id, client_msg_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN -- lost a race with an identical retry: return the winner
    SELECT o.id, o.status INTO v_existing FROM wa_outbox o WHERE o.channel_id = v_channel AND o.client_msg_id = p_client_msg_id;
    RETURN jsonb_build_object('ok', true, 'id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_enqueue_reply(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_enqueue_reply(uuid, text, text, uuid) TO service_role;
