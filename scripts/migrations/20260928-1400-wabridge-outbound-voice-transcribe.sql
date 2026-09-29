-- WhatsApp bridge: give a voice note YOU send (recorded in the CRM) the same duration + transcript
-- a note you RECEIVE already gets. Antonio 2026-09-28: "the message went through but there is no time
-- duration and transcript."
--
-- Root cause: wabridge_finish_send / wabridge_resolve_outbox pre-inserted the note's message_media row as
-- status='ready' the moment the send succeeded. 'ready' is a TERMINAL status — wabridge_media_claim only
-- ever picks up a message with NO message_media row yet, or one sitting at 'waiting' (see its own WHERE
-- clause), so a note landing pre-marked 'ready' was permanently invisible to the Mac's listen+transcribe
-- job. That job is the ONLY thing that ever fills duration_seconds / transcript — nothing else touches
-- those columns. Immediate playback worked (a 'ready' row with storage_path pointing at the file already
-- uploaded to send it), which is why sending looked fine while duration/transcript silently never arrived.
--
-- Fix (wabridge_finish_send ONLY — see note on wabridge_resolve_outbox below): stop pre-inserting the
-- message_media row for a voice send. Leave it absent, exactly like an inbound voice note starts out. On
-- its next ~20s cycle wabridge_media_claim finds the new 'voice' message (content_type='voice',
-- external_message_id now set, no message_media row) and claims it — same as an inbound note. The Mac then
-- re-downloads its own just-sent copy from WhatsApp via GOWA (a message the account itself sent is a normal
-- message in GOWA's local store, downloadable the same way as any other), measures the real duration with
-- ffprobe, transcribes locally, and reports back — filling storage_path, duration_seconds and transcript
-- through wabridge_media_finish exactly as it does today for a note a client sent. No new Mac code, no new
-- table, no second pipeline.
--
-- Trade-off, stated plainly: playback is no longer available in the same second you send — it becomes
-- playable once the Mac's next cycle finishes (normally under ~20s, matching how long a RECEIVED note takes
-- today). Nothing before this showed duration or transcript at all, so this is a net gain with a short,
-- already-familiar delay, not a regression against anything that worked before.
--
-- wabridge_resolve_outbox (the manual "mark as sent by staff" override, used when the Mac's own report never
-- arrived) is DELIBERATELY left untouched: that path never learns the real WhatsApp message id, so there is
-- nothing for the Mac to re-download or transcribe — the immediate 'ready' row with no duration/transcript
-- is the correct, honest behavior there, not a bug.
--
-- Sandbox: node scripts/apply-migration.js scripts/migrations/20260928-1400-wabridge-outbound-voice-transcribe.sql
-- Production: Antonio runs it in the Supabase SQL editor (execute_sql DDL promotion path is retired).

CREATE OR REPLACE FUNCTION public.wabridge_finish_send(p_channel_id uuid, p_outbox_id uuid, p_ok boolean, p_message_id text, p_error text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      -- voice: no message_media row here on purpose — wabridge_media_claim picks up this new voice message
      -- on its own (no row yet = eligible, same as an inbound note) and fills duration + transcript through
      -- the SAME Mac pipeline. See the migration header for the full reasoning.
    END IF;
    RETURN jsonb_build_object('ok', true, 'status', 'sent');
  END IF;

  UPDATE wa_outbox SET status = 'failed', error = left(COALESCE(NULLIF(btrim(p_error), ''), 'send failed'), 500) WHERE id = o.id;
  RETURN jsonb_build_object('ok', true, 'status', 'failed');
END;
$function$;
