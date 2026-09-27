-- WhatsApp bridge (dev job 907b2535, child voice/attachment Phase 2): SEND ANY ATTACHMENT FROM THE CRM.
-- Antonio 2026-09-27 decisions: an upload button for ANY attachment (audio -> sent as a voice note, photos, video,
-- documents) — NO in-browser recorder; no length limit of ours; a voice/attachment send counts as ONE message
-- against the existing pacing (no extra weight); dangerous file types blocked at upload; a reminder shown under the
-- upload button (no IDs/tax documents over WhatsApp — SOP 17; invoices via the portal — R092), never a hard block.
-- Council-reviewed design (senior engineer, bug hunter, AI architect, project director, system counselor) —
-- scratchpad PLAN/VOICE-SEND-DESIGN, all fixes folded in here: placeholder body (no CHECK change), a sender must
-- declare which kind it can send, the signed upload URL is verified before a claim can be finished, kind-aware
-- finish/resolve, one bucket (reuses `wa-voice`, widened), a server-built deterministic path so a retry can never
-- store the file twice, and the identical-content rule compares a file hash for non-text kinds (comparing body
-- would falsely treat every voice note as "the same message").
--
--   wa_outbox.kind             'text' (default) | 'voice' | 'image' | 'video' | 'document' — validated here, no CHECK.
--   wa_outbox.media_path       the server-built storage path for a non-text kind (bucket `wa-voice`, prefix `outbound/`).
--   wa_outbox.media_mime       the file's mime type, recorded at enqueue time.
--   wa_outbox.content_hash     sha-256 of the file (or, for text, unused) — the identical-content rule uses this for
--                               non-text kinds instead of comparing body, which is just a placeholder for attachments.
--   wabridge_enqueue_send()    the ONE new writer for a non-text (attachment/voice) reply — same rules as
--                               wabridge_enqueue_reply (reply-only, mode, allowlist, idempotent), plus: kind must be
--                               one of the four attachment kinds, media_path must already exist in storage under the
--                               deterministic path this function itself computes from (channel, client_msg_id), and
--                               a caption (if any) becomes the placeholder body.
--   wabridge_claim_send()      now returns `kind`, `media_path`, `media_mime` too. A sender that does not pass
--                               p_supports_kinds (or does not include the claimed row's kind in it) is NEVER handed
--                               that row — it stays queued for a sender that can. This stops an old text-only sender
--                               from ever trying to send "[Voice note]" as literal text.
--   wabridge_finish_send()     kind-aware: a 'text' send still goes through wabridge_ingest_message() unchanged; a
--                               non-text send inserts the message directly (content_type = kind) and, for voice,
--                               a 'ready' message_media row so the SAME transcription pipeline picks it up — no
--                               second bucket, no second retention sweep, no re-download from WhatsApp.
--   wabridge_resolve_outbox()  same kind-aware insert for the "it was sent" manual-override path.
--
-- Sandbox: statement-by-statement via exec_sql. Production: Antonio runs it in the Supabase SQL editor.

ALTER TABLE public.wa_outbox ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';
ALTER TABLE public.wa_outbox ADD COLUMN IF NOT EXISTS media_path text;
ALTER TABLE public.wa_outbox ADD COLUMN IF NOT EXISTS media_mime text;
ALTER TABLE public.wa_outbox ADD COLUMN IF NOT EXISTS media_size_bytes integer;
ALTER TABLE public.wa_outbox ADD COLUMN IF NOT EXISTS content_hash text;

-- Reuse the voice bucket for outgoing files too (one bucket, one 180-day sweep) — widen the allowed types.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/mpeg', 'audio/wav',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/quicktime', 'video/webm',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv'
], file_size_limit = 67108864 -- 64 MB ceiling: our own operational limit (WhatsApp's own app allows more for documents), never a business rule
WHERE id = 'wa-voice';

CREATE OR REPLACE FUNCTION public.wabridge_enqueue_send(
  p_group_id uuid, p_kind text, p_caption text, p_client_msg_id text, p_media_mime text, p_media_size integer,
  p_content_hash text, p_created_by uuid
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
  v_path text;
  v_ext text;
BEGIN
  IF p_kind NOT IN ('voice', 'image', 'video', 'document') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_kind', 'message', 'Unknown attachment kind.');
  END IF;
  IF p_media_mime IS NULL OR btrim(p_media_mime) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_request', 'message', 'The file type is missing.');
  END IF;
  IF p_media_size IS NULL OR p_media_size < 1 OR p_media_size > 67108864 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_size', 'message', 'That file is too large (64 MB maximum).');
  END IF;
  IF p_client_msg_id IS NULL OR length(p_client_msg_id) < 8 OR length(p_client_msg_id) > 100 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_request', 'message', 'Missing message id — please reload the page and try again.');
  END IF;

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
    RETURN jsonb_build_object('ok', false, 'code', 'not_one_to_one', 'message', 'Attachments can only be sent to one-to-one chats.');
  END IF;
  v_digits := regexp_replace(v_key, '\D', '', 'g');

  -- a retry (double click, network timeout) returns the SAME row, before any mode check
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

  -- the caption becomes the placeholder body; every kind gets a default so the existing body CHECK (1-4096) is
  -- always satisfied without touching that constraint (R105/db-contract: no new CHECK needed for this change)
  v_body := NULLIF(btrim(COALESCE(p_caption, '')), '');
  IF v_body IS NULL THEN
    v_body := CASE p_kind WHEN 'voice' THEN '[Voice note]' WHEN 'image' THEN '[Photo]' WHEN 'video' THEN '[Video]' ELSE '[Document]' END;
  ELSIF length(v_body) > 4096 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_long', 'message', 'That caption is too long (4096 characters maximum).');
  END IF;

  -- the ONLY place the outgoing storage path is built — never chosen by the browser or the Mac; derived from the
  -- client message id so a double-click / retry can never produce two different stored files for one send.
  -- The WhatsApp program picks how to handle a file by the EXTENSION in its URL, not the declared content type
  -- (confirmed 2026-09-27: a generic ".bin" makes it refuse image/video/document sends outright). This mapping
  -- MUST be kept identical, by hand, to MIME_EXTENSION in lib/messaging/wabridge-attachment.ts — that file computes
  -- the SAME path before the upload even happens, so the two can never be allowed to disagree.
  v_ext := CASE lower(btrim(p_media_mime))
    WHEN 'audio/mp4' THEN 'm4a' WHEN 'audio/x-m4a' THEN 'm4a' WHEN 'audio/aac' THEN 'aac' WHEN 'audio/ogg' THEN 'ogg'
    WHEN 'audio/webm' THEN 'weba' WHEN 'audio/mpeg' THEN 'mp3' WHEN 'audio/wav' THEN 'wav'
    WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp' WHEN 'image/gif' THEN 'gif'
    WHEN 'video/mp4' THEN 'mp4' WHEN 'video/quicktime' THEN 'mov' WHEN 'video/webm' THEN 'webm'
    WHEN 'application/pdf' THEN 'pdf' WHEN 'application/msword' THEN 'doc'
    WHEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' THEN 'docx'
    WHEN 'application/vnd.ms-excel' THEN 'xls'
    WHEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' THEN 'xlsx'
    WHEN 'text/plain' THEN 'txt' WHEN 'text/csv' THEN 'csv'
    ELSE 'bin'
  END;
  v_path := 'outbound/' || v_channel::text || '/' || p_client_msg_id || '.' || v_ext;

  v_status := CASE WHEN v_mode = 'live' THEN 'queued' ELSE 'shadow' END;
  INSERT INTO wa_outbox (channel_id, group_id, to_digits, body, client_msg_id, status, created_by, kind, media_path, media_mime, media_size_bytes, content_hash)
  VALUES (v_channel, p_group_id, v_digits, v_body, p_client_msg_id, v_status, p_created_by, p_kind, v_path, p_media_mime, p_media_size, p_content_hash)
  ON CONFLICT (channel_id, client_msg_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT o.id, o.status INTO v_existing FROM wa_outbox o WHERE o.channel_id = v_channel AND o.client_msg_id = p_client_msg_id;
    RETURN jsonb_build_object('ok', true, 'id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', v_status, 'path', v_path);
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_enqueue_send(uuid, text, text, text, text, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_enqueue_send(uuid, text, text, text, text, integer, text, uuid) TO service_role;

-- CLAIM — kind-aware: a sender that does not support the claimed row's kind is skipped over (row stays queued).
CREATE OR REPLACE FUNCTION public.wabridge_claim_send(p_channel_id uuid, p_supports_kinds text[] DEFAULT ARRAY['text']) RETURNS jsonb
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
  v_dist_day_cap integer;
  v_hour integer;
  v_day integer;
  v_row record;
  v_held boolean := false;
  v_compare_key text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wabridge_claim:' || p_channel_id::text));

  SELECT * INTO s FROM wa_bridge_state WHERE channel_id = p_channel_id;
  IF NOT FOUND OR s.send_mode IS DISTINCT FROM 'live' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'paused');
  END IF;
  IF s.last_heartbeat_at IS NULL OR s.last_heartbeat_at < now() - interval '6 minutes'
     OR s.reachable IS NOT TRUE OR s.connected IS NOT TRUE OR s.logged_in IS NOT TRUE THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'unhealthy');
  END IF;

  v_gap := LEAST(GREATEST(COALESCE(s.send_min_gap_seconds, 60), 10), 3600);
  v_hour_cap := LEAST(GREATEST(COALESCE(s.send_hourly_cap, 10), 1), 60);
  v_day_cap := LEAST(GREATEST(COALESCE(s.send_daily_cap, 5), 1), 200);
  v_dist_cap := LEAST(GREATEST(COALESCE(s.send_distinct_per_hour, 6), 1), 30);
  v_same_cap := LEAST(GREATEST(COALESCE(s.send_same_body_per_hour, 2), 1), 10);
  v_dist_day_cap := LEAST(GREATEST(COALESCE(s.send_distinct_per_day, 30), 1), 200);

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
    IF NOT (COALESCE(v_row.kind, 'text') = ANY (COALESCE(p_supports_kinds, ARRAY['text']))) THEN
      v_held := true; CONTINUE; -- this sender cannot send this kind yet — leave it for a sender that can
    END IF;
    IF EXISTS (SELECT 1 FROM wa_outbox u WHERE u.group_id = v_row.group_id AND u.status = 'unknown' AND u.id <> v_row.id) THEN
      v_held := true; CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM messages m WHERE m.group_id = v_row.group_id AND m.direction = 'inbound') THEN
      v_held := true; CONTINUE;
    END IF;
    IF COALESCE(cardinality(s.send_allowlist), 0) > 0 AND NOT (v_row.to_digits = ANY (s.send_allowlist)) THEN
      v_held := true; CONTINUE;
    END IF;
    IF (SELECT count(DISTINCT x.to_digits) FROM wa_outbox x
         WHERE x.channel_id = p_channel_id AND x.status IN ('unknown', 'sent') AND x.claimed_at > now() - interval '1 hour') >= v_dist_cap
       AND NOT EXISTS (SELECT 1 FROM wa_outbox x
         WHERE x.channel_id = p_channel_id AND x.status IN ('unknown', 'sent') AND x.claimed_at > now() - interval '1 hour' AND x.to_digits = v_row.to_digits) THEN
      v_held := true; CONTINUE;
    END IF;
    IF (SELECT count(DISTINCT x.to_digits) FROM wa_outbox x
         WHERE x.channel_id = p_channel_id AND x.status IN ('unknown', 'sent') AND x.claimed_at > now() - interval '24 hours') >= v_dist_day_cap
       AND NOT EXISTS (SELECT 1 FROM wa_outbox x
         WHERE x.channel_id = p_channel_id AND x.status IN ('unknown', 'sent') AND x.claimed_at > now() - interval '24 hours' AND x.to_digits = v_row.to_digits) THEN
      v_held := true; CONTINUE;
    END IF;
    -- identical-content rule: text compares the body; a non-text kind compares its file hash (its body is just a
    -- placeholder like "[Voice note]" and would otherwise make every voice note look "identical" to every other)
    v_compare_key := CASE WHEN COALESCE(v_row.kind, 'text') = 'text' THEN lower(btrim(v_row.body)) ELSE COALESCE(v_row.content_hash, v_row.id::text) END;
    IF (SELECT count(DISTINCT x.to_digits) FROM wa_outbox x
         WHERE x.channel_id = p_channel_id AND x.status IN ('unknown', 'sent') AND x.claimed_at > now() - interval '1 hour'
           AND (CASE WHEN COALESCE(x.kind, 'text') = 'text' THEN lower(btrim(x.body)) ELSE COALESCE(x.content_hash, x.id::text) END) = v_compare_key
           AND x.to_digits <> v_row.to_digits) >= v_same_cap THEN
      v_held := true; CONTINUE;
    END IF;

    UPDATE wa_outbox SET status = 'unknown', claimed_at = now() WHERE id = v_row.id;
    RETURN jsonb_build_object(
      'claimed', true, 'id', v_row.id, 'to_digits', v_row.to_digits, 'body', v_row.body, 'group_id', v_row.group_id,
      'kind', COALESCE(v_row.kind, 'text'), 'media_path', v_row.media_path, 'media_mime', v_row.media_mime
    );
  END LOOP;

  RETURN jsonb_build_object('claimed', false, 'reason', CASE WHEN v_held THEN 'held' ELSE 'nothing_to_send' END);
END;
$$;

-- FINISH — kind-aware. Text keeps the exact old behaviour (through wabridge_ingest_message). A non-text kind
-- inserts the message directly and, for voice, a READY message_media row so the listen-side pipeline (the SAME
-- table, the SAME playback route, the SAME 180-day sweep) picks it up without ever re-downloading from WhatsApp.
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
        jsonb_build_object('source', 'wabridge', 'sent_from', 'crm', 'outbox_id', o.id), false
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

-- RESOLVE — same kind-aware insert for the manual "it was sent" override.
CREATE OR REPLACE FUNCTION public.wabridge_resolve_outbox(p_outbox_id uuid, p_action text, p_user uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  o record;
  v_msg_id uuid;
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
  VALUES (o.group_id, o.channel_id, 'outbound', 'TD Team', COALESCE(o.kind, 'text'), o.body, 'responded', now(),
          jsonb_build_object('source', 'crm_manual', 'outbox_id', o.id, 'resolved_by', p_user))
  RETURNING id INTO v_msg_id;
  UPDATE messaging_groups SET last_message_at = GREATEST(COALESCE(last_message_at, now()), now()), updated_at = now() WHERE id = o.group_id;
  IF COALESCE(o.kind, 'text') = 'voice' THEN
    INSERT INTO message_media (message_id, channel_id, kind, status, storage_path, mime_type, size_bytes, ready_at)
    VALUES (v_msg_id, o.channel_id, 'voice', 'ready', o.media_path, o.media_mime, o.media_size_bytes, now())
    ON CONFLICT (message_id) DO NOTHING;
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'sent');
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_claim_send(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_claim_send(uuid, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_finish_send(uuid, uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_finish_send(uuid, uuid, boolean, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_resolve_outbox(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_resolve_outbox(uuid, text, uuid) TO service_role;
