-- WhatsApp reactions made ON THE PHONE (clients' and the business line's own) → the CRM (dev job 5962e46d, Release 1).
--
-- Antonio 2026-10-06: "if I send the reaction from the CRM it must appear on the phone and vice versa." This is the
-- phone → CRM half. It only DISPLAYS what WhatsApp already holds; it sends nothing to anyone.
--
-- How the data gets here: a small always-on job on the Mac reads the WhatsApp program's own reaction records
-- (read-only), works out what changed, and posts signed batches ('bridge.reactions') to the receiver, which calls
-- the function below. WhatsApp allows ONE reaction per person per message, so a 1:1 chat has at most two sides:
-- the client and the business line. Each side is one element in messages.reactions:
--   {emoji, reactor_id:'wa-client'|'wa-line', reactor_type:'client'|'line', reactor_name:null, created_at,
--    scan_ms, source:'phone'}            ← what is on the phone now
--   {emoji:'', …, removed_at, scan_ms}   ← a TOMBSTONE: the reaction was removed. It keeps the last decision's
--                                         scan_ms so a late, replayed older "add" cannot bring it back.
-- Existing CRM-only staff marks (reactor_type 'staff', made with wabridge_toggle_reaction) are NEVER touched.
--
-- Ordering uses ONE clock only: scan_ms = when the Mac took the snapshot (epoch ms). Phone clocks are never compared.
-- Removals (a row that vanished) are applied only while the bridge is healthy (reachable + connected + logged in +
-- a heartbeat in the last 3 minutes); otherwise they are HELD and the Mac simply reports them again next scan —
-- after a re-link the program's records can be briefly incomplete and must not wipe real reactions.
--
-- This function writes messages.reactions and nothing else: no status, no unread count, no last_message_at, no
-- messaging_groups (a reaction must never bump unread or revive a hidden chat — wabridge_ingest_message does those,
-- on purpose, and is not used here).
--
-- No value-list CHECK constraints (the db-contract gate): every rule is enforced inside the function.

ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS reactions_seen_at timestamptz;

CREATE OR REPLACE FUNCTION public.wabridge_apply_observed_reactions(
  p_channel_id uuid, p_items jsonb, p_scan_ms bigint
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_items jsonb := COALESCE(p_items, '[]'::jsonb);
  v_n int;
  v_i int;
  it jsonb;
  v_res jsonb := '[]'::jsonb;
  v_r text;
  v_ext text;
  v_chat text;
  v_side text;
  v_op text;
  v_emoji text;
  v_norm text;
  v_reacted timestamptz;
  v_msg_id uuid;
  v_reactions jsonb;
  v_group_digits text;
  v_idx int;
  v_elem jsonb;
  v_elem_norm text;
  v_elem_scan bigint;
  v_new jsonb;
  v_healthy boolean;
BEGIN
  IF jsonb_typeof(v_items) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_items');
  END IF;
  v_n := jsonb_array_length(v_items);
  IF v_n > 500 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_many');
  END IF;
  IF p_scan_ms IS NULL OR p_scan_ms <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_scan');
  END IF;

  SELECT (reachable AND connected AND logged_in AND last_heartbeat_at > now() - interval '3 minutes')
    INTO v_healthy
    FROM wa_bridge_state WHERE channel_id = p_channel_id;
  v_healthy := COALESCE(v_healthy, false);

  FOR v_i IN 0 .. v_n - 1 LOOP
    it := v_items -> v_i;
    v_r := NULL;

    IF jsonb_typeof(it) <> 'object' THEN
      v_res := v_res || jsonb_build_array(jsonb_build_object('i', v_i, 'r', 'invalid'));
      CONTINUE;
    END IF;

    v_ext := it->>'ext_id';
    v_chat := it->>'chat';
    v_side := it->>'side';
    v_op := it->>'op';
    v_emoji := it->>'emoji';

    IF v_ext IS NULL OR v_ext !~ '^[A-Za-z0-9]{4,64}$'
       OR v_chat IS NULL OR v_chat !~ '^[0-9]{6,15}$'
       OR v_side IS NULL OR v_side NOT IN ('client', 'line')
       OR v_op IS NULL OR v_op NOT IN ('set', 'remove') THEN
      v_res := v_res || jsonb_build_array(jsonb_build_object('i', v_i, 'r', 'invalid'));
      CONTINUE;
    END IF;
    IF v_op = 'set' AND (v_emoji IS NULL OR char_length(v_emoji) = 0 OR char_length(v_emoji) > 32
                         OR v_emoji ~ '\s' OR v_emoji ~ '^[A-Za-z0-9]+$') THEN
      v_res := v_res || jsonb_build_array(jsonb_build_object('i', v_i, 'r', 'invalid'));
      CONTINUE;
    END IF;

    v_reacted := NULL;
    BEGIN
      v_reacted := (it->>'reacted_at')::timestamptz;
    EXCEPTION WHEN others THEN
      v_reacted := NULL;
    END;

    -- The message (lock it) — and the chat it sits in must be the one the Mac named.
    v_msg_id := NULL;
    SELECT m.id, COALESCE(m.reactions, '[]'::jsonb), regexp_replace(g.external_group_id, '@.*$', '')
      INTO v_msg_id, v_reactions, v_group_digits
      FROM messages m
      JOIN messaging_groups g ON g.id = m.group_id
     WHERE m.external_message_id = v_ext AND m.channel_id = p_channel_id
     FOR UPDATE OF m;
    IF v_msg_id IS NULL OR v_group_digits IS DISTINCT FROM v_chat THEN
      v_res := v_res || jsonb_build_array(jsonb_build_object('i', v_i, 'r', 'unmatched'));
      CONTINUE;
    END IF;

    -- This side's current element, if any.
    v_idx := NULL;
    v_elem := NULL;
    SELECT (t.ord - 1)::int, t.elem INTO v_idx, v_elem
      FROM jsonb_array_elements(v_reactions) WITH ORDINALITY AS t(elem, ord)
     WHERE t.elem->>'reactor_type' = v_side
     LIMIT 1;
    v_elem_scan := COALESCE((v_elem->>'scan_ms')::bigint, 0);
    v_elem_norm := replace(COALESCE(v_elem->>'emoji', ''), chr(65039), '');

    IF v_elem IS NOT NULL AND v_elem_scan > p_scan_ms THEN
      v_res := v_res || jsonb_build_array(jsonb_build_object('i', v_i, 'r', 'stale'));
      CONTINUE;
    END IF;

    IF v_op = 'set' THEN
      v_norm := replace(v_emoji, chr(65039), '');
      IF v_elem IS NOT NULL AND v_elem_norm = v_norm THEN
        v_r := 'noop';
      ELSE
        v_new := jsonb_build_object(
          'emoji', v_emoji,
          'reactor_id', 'wa-' || v_side,
          'reactor_type', v_side,
          'reactor_name', NULL,
          'created_at', to_jsonb(COALESCE(v_reacted, now())),
          'scan_ms', p_scan_ms,
          'source', 'phone'
        );
        v_r := 'applied';
      END IF;
    ELSE
      IF v_elem IS NULL OR v_elem_norm = '' THEN
        v_r := 'noop';
      ELSIF NOT v_healthy THEN
        v_r := 'held';
      ELSE
        v_new := jsonb_build_object(
          'emoji', '',
          'reactor_id', 'wa-' || v_side,
          'reactor_type', v_side,
          'reactor_name', NULL,
          'created_at', v_elem->'created_at',
          'removed_at', to_jsonb(now()),
          'scan_ms', p_scan_ms,
          'source', 'phone'
        );
        v_r := 'applied';
      END IF;
    END IF;

    IF v_r = 'applied' THEN
      IF v_idx IS NULL THEN
        v_reactions := v_reactions || jsonb_build_array(v_new);
      ELSE
        v_reactions := jsonb_set(v_reactions, ARRAY[v_idx::text], v_new);
      END IF;
      UPDATE messages SET reactions = v_reactions WHERE id = v_msg_id;
    END IF;

    v_res := v_res || jsonb_build_array(jsonb_build_object('i', v_i, 'r', v_r));
  END LOOP;

  -- The Mac's "I am alive and scanning" beat — even an empty batch counts (Release 2 refuses to send while it is stale).
  UPDATE wa_bridge_state SET reactions_seen_at = now() WHERE channel_id = p_channel_id;

  RETURN jsonb_build_object('ok', true, 'results', v_res);
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_apply_observed_reactions(uuid, jsonb, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_apply_observed_reactions(uuid, jsonb, bigint) TO service_role;
