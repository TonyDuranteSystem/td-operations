-- WhatsApp delivery / read ticks on OUR outgoing messages (dev job 89d3ad80).
--
-- Antonio 2026-10-09: "in the CRM inbox, in WhatsApp, I want to see if the client read the message."
--
-- The Mac's WhatsApp program (GOWA) can tell us when a message reached the person's phone ("delivered") and when
-- they opened the chat ("read") — event 'message.ack' with ids[] and receipt_type. Until now the Mac was told to
-- forward 'message' events only, and the receiver had nowhere to put a receipt.
--
-- These two columns are deliberately NOT messages.status: status 'read' on a message is a different, staff-side
-- meaning (we handled it), and wabridge_ingest_message treats it as such. A receipt only ever sets these two columns.
--
-- Rules enforced in the function (no value-list CHECK constraints — the db-contract gate):
--   * OUTBOUND messages only (a receipt is always about something we sent, from the phone or from the CRM).
--   * Matched by external_message_id (WhatsApp's own id) within this channel.
--   * Timestamps only move FORWARD in meaning: 'read' also fills delivered_at (read implies delivered); a later
--     receipt never erases an earlier one; the first value wins (WhatsApp may repeat a receipt).
--   * Writes delivered_at / read_at and NOTHING else: no unread count, no last_message_at, no revive of a hidden
--     chat, no reactions, no status.
--   * A receipt for a message we do not have (yet) reports 'unmatched' — the receiver answers 200 and the Mac does
--     not retry (a receipt is cosmetic; the message row arriving later simply shows no ticks until the next receipt).

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS read_at timestamptz;

CREATE OR REPLACE FUNCTION public.wabridge_apply_receipts(
  p_channel_id uuid,
  p_ids text[],
  p_receipt_type text,
  p_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text := lower(COALESCE(p_receipt_type, ''));
  v_at timestamptz := COALESCE(p_at, now());
  v_applied int := 0;
  v_seen int := 0;
BEGIN
  IF v_kind NOT IN ('delivered', 'read') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_receipt_type');
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'matched', 0, 'applied', 0);
  END IF;
  -- Never trust a stamp from the future (clock skew / garbage): cap at now.
  IF v_at > now() THEN v_at := now(); END IF;

  WITH target AS (
    SELECT m.id
      FROM public.messages m
     WHERE m.channel_id = p_channel_id
       AND m.direction = 'outbound'
       AND m.external_message_id = ANY (p_ids)
  ), counted AS (
    SELECT count(*) AS n FROM target
  ), upd AS (
    UPDATE public.messages m
       SET delivered_at = CASE
                            WHEN m.delivered_at IS NULL THEN v_at
                            ELSE m.delivered_at
                          END,
           read_at = CASE
                       WHEN v_kind = 'read' AND m.read_at IS NULL THEN v_at
                       ELSE m.read_at
                     END
      FROM target t
     WHERE m.id = t.id
       AND ( m.delivered_at IS NULL
             OR (v_kind = 'read' AND m.read_at IS NULL) )
    RETURNING m.id
  )
  SELECT (SELECT n FROM counted), (SELECT count(*) FROM upd)
    INTO v_seen, v_applied;

  RETURN jsonb_build_object('ok', true, 'matched', v_seen, 'applied', v_applied);
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_apply_receipts(uuid, text[], text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_apply_receipts(uuid, text[], text, timestamptz) TO service_role;
