-- WhatsApp bridge: actually SAVE photos/videos/documents people send in, instead of the "[Photo]" placeholder
-- with nothing behind it. Antonio 2026-09-28: Patrick Covelli sent two photos that could not be opened —
-- confirmed the connection was deliberately told not to auto-download any media at all (messaging.md, Voice
-- Notes Phase 1 section), so this is a real gap, not a bug. Antonio approved building it (2026-09-28, "scope
-- both" / "go ahead").
--
-- Design: reuse the EXACT SAME claim → download → upload → report pipeline already built and proven for
-- voice notes (wabridge_media_claim / wabridge_media_finish), widened to also pick up 'image' | 'video' |
-- 'document' messages. No new table, no new bucket, no new Mac job — media-loop.sh (this same migration's
-- sibling change on the Mac) gets one new branch: skip the ffmpeg/whisper steps for a non-voice kind, keep
-- the file's own bytes and real mime, otherwise identical (same claim, same signed upload, same report).
--
-- Why this naturally only touches INBOUND media: an OUTBOUND image/video/document (one staff sends from the
-- CRM) already gets an immediate 'ready' message_media row at send time (wabridge_finish_send, untouched by
-- this migration) — so by the time this claim function looks for "not yet handled" media, an outbound
-- attachment already has a row and is correctly skipped. Only a genuinely new INBOUND attachment, which has
-- no row yet, is eligible — the same "no row yet = eligible" rule voice already relies on, no extra filter
-- needed.
--
-- storage_path convention: voice keeps its existing 'voice/<channel>/<message>.m4a' path untouched (nothing
-- about already-processed or in-flight voice notes changes shape). A non-voice attachment lands under
-- 'media/<channel>/<message>.<ext>', ext derived from the REAL mime type the Mac reports after downloading
-- (WhatsApp's program decides file handling by extension, not declared mime — same reasoning already used
-- for outbound attachments in the 2026-09-27 migration; this is the identical mapping, kept in sync by
-- necessity, not a new decision).
--
-- Size ceiling: unchanged 25 MB for voice (matches what the Mac's own audio conversion targets). Widened to
-- the bucket's real 64 MB ceiling for image/video/document, matching the ceiling outbound attachments already
-- use.
--
-- 25-day "WhatsApp no longer serves this" rule: applied the SAME way to every kind. This was MEASURED for
-- voice notes specifically (19 days ok, 26 days gone, 2026-09-26); it is assumed, not independently measured,
-- to hold for images/video/documents too, since it reflects WhatsApp's own media-serving window rather than
-- anything voice-specific. If a stale photo ever comes back 403/404/410 sooner or later than 25 days, the
-- Mac already reports that as 'expired' either way — worst case is one wasted claim cycle, never a stuck row.
--
-- Retention: message_media's existing 180-day sweep (wabridge_media_expired_list / wabridge_media_mark_deleted)
-- already operates on ANY row regardless of kind — no change needed, photos/videos/documents get the same
-- 180-day keep-then-delete-the-file-keep-nothing-else policy voice notes already have.
--
-- Visibility: staff-only, same as voice (Antonio 2026-09-26: only Antonio and Luca may see WhatsApp media).
-- Enforced server-side in the messages route (sibling app-code change), not by anything in this migration.
--
-- Sandbox: node scripts/apply-migration.js scripts/migrations/20260928-1500-wabridge-inbound-photo-download.sql
-- Production: Antonio runs it in the Supabase SQL editor (execute_sql DDL promotion path is retired).

CREATE OR REPLACE FUNCTION public.wabridge_media_claim(p_channel_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row record;
  v_media_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wabridge_media_claim:' || p_channel_id::text));

  -- WhatsApp no longer serves media older than ~25 days: record that once per message, never ask the Mac.
  -- Applies to every media kind (see migration header on the 25-day assumption).
  INSERT INTO message_media (message_id, channel_id, kind, status, error)
  SELECT m.id, m.channel_id, m.content_type, 'expired', 'older than WhatsApp keeps this media'
  FROM messages m
  WHERE m.channel_id = p_channel_id AND m.content_type IN ('voice', 'image', 'video', 'document')
    AND m.created_at < now() - interval '25 days'
    AND NOT EXISTS (SELECT 1 FROM message_media x WHERE x.message_id = m.id)
  ORDER BY m.created_at
  LIMIT 500
  ON CONFLICT (message_id) DO NOTHING;

  -- notes/attachments stuck in 'processing' for 15 minutes with the attempts used up: give up
  UPDATE message_media SET status = 'failed', error = COALESCE(error, 'gave up after 3 attempts'), updated_at = now()
  WHERE channel_id = p_channel_id AND status = 'processing' AND claimed_at < now() - interval '15 minutes' AND attempts >= 3;

  -- oldest recoverable first (the oldest expire first)
  SELECT m.id AS message_id, m.external_message_id, m.direction, m.content_type, m.created_at, g.external_group_id
    INTO v_row
  FROM messages m
  JOIN messaging_groups g ON g.id = m.group_id
  LEFT JOIN message_media x ON x.message_id = m.id
  WHERE m.channel_id = p_channel_id
    AND m.content_type IN ('voice', 'image', 'video', 'document')
    AND m.external_message_id IS NOT NULL
    AND m.created_at >= now() - interval '25 days'
    AND g.external_group_id ~ '^[0-9]{6,15}(@c\.us)?$'
    AND (
      x.id IS NULL
      OR x.status = 'waiting'
      OR (x.status = 'processing' AND x.claimed_at < now() - interval '15 minutes' AND x.attempts < 3)
    )
  ORDER BY m.created_at
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'nothing_to_do');
  END IF;

  INSERT INTO message_media (message_id, channel_id, kind, status, attempts, claimed_at)
  VALUES (v_row.message_id, p_channel_id, v_row.content_type, 'processing', 1, now())
  ON CONFLICT (message_id) DO UPDATE
    SET status = 'processing', attempts = message_media.attempts + 1, claimed_at = now(), updated_at = now()
  RETURNING id INTO v_media_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'message_id', v_row.message_id,
    'external_id', v_row.external_message_id,
    'kind', v_row.content_type,
    'chat_digits', regexp_replace(v_row.external_group_id, '\D', '', 'g'),
    'from_me', v_row.direction = 'outbound',
    'created_at', v_row.created_at,
    -- voice keeps its fixed, already-relied-upon path; a non-voice kind has no path yet — the Mac learns
    -- the real mime only after downloading, and wabridge_media_finish computes + verifies the real path then.
    'path', CASE WHEN v_row.content_type = 'voice' THEN 'voice/' || p_channel_id::text || '/' || v_row.message_id::text || '.m4a' ELSE NULL END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_media_finish(
  p_channel_id uuid, p_message_id uuid, p_outcome text, p_path text, p_mime text, p_size integer,
  p_duration integer, p_transcript text, p_language text, p_model text, p_error text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  x record;
  v_kind text;
  v_ext text;
  v_path text;
  v_max_size integer;
BEGIN
  SELECT * INTO x FROM message_media WHERE message_id = p_message_id AND channel_id = p_channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF x.status = 'ready' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', 'ready');
  END IF;
  IF x.status <> 'processing' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_in_progress', 'status', x.status);
  END IF;

  v_kind := COALESCE(x.kind, 'voice');

  IF p_outcome = 'ready' THEN
    IF v_kind = 'voice' THEN
      v_path := 'voice/' || p_channel_id::text || '/' || p_message_id::text || '.m4a';
      v_max_size := 26214400;
    ELSE
      v_ext := CASE lower(btrim(COALESCE(p_mime, '')))
        WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp' WHEN 'image/gif' THEN 'gif'
        WHEN 'video/mp4' THEN 'mp4' WHEN 'video/quicktime' THEN 'mov' WHEN 'video/webm' THEN 'webm'
        WHEN 'application/pdf' THEN 'pdf' WHEN 'application/msword' THEN 'doc'
        WHEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' THEN 'docx'
        WHEN 'application/vnd.ms-excel' THEN 'xls'
        WHEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' THEN 'xlsx'
        WHEN 'text/plain' THEN 'txt' WHEN 'text/csv' THEN 'csv'
        ELSE 'bin'
      END;
      v_path := 'media/' || p_channel_id::text || '/' || p_message_id::text || '.' || v_ext;
      v_max_size := 67108864;
    END IF;

    IF p_path IS DISTINCT FROM v_path THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_path');
    END IF;
    IF p_size IS NULL OR p_size < 1 OR p_size > v_max_size THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_size');
    END IF;
    UPDATE message_media SET
      status = 'ready', storage_path = v_path, mime_type = left(COALESCE(p_mime, 'application/octet-stream'), 60), size_bytes = p_size,
      duration_seconds = CASE WHEN v_kind = 'voice' THEN GREATEST(COALESCE(p_duration, 0), 0) ELSE NULL END,
      transcript = CASE WHEN v_kind = 'voice' THEN NULLIF(left(COALESCE(p_transcript, ''), 50000), '') ELSE NULL END,
      transcript_language = CASE WHEN v_kind = 'voice' THEN NULLIF(left(COALESCE(p_language, ''), 12), '') ELSE NULL END,
      transcript_model = CASE WHEN v_kind = 'voice' THEN NULLIF(left(COALESCE(p_model, ''), 80), '') ELSE NULL END,
      error = NULL, ready_at = now(), updated_at = now()
    WHERE id = x.id;
    RETURN jsonb_build_object('ok', true, 'status', 'ready');
  ELSIF p_outcome = 'expired' THEN
    UPDATE message_media SET status = 'expired', error = left(COALESCE(NULLIF(btrim(p_error), ''), 'no longer on WhatsApp'), 300), updated_at = now() WHERE id = x.id;
    RETURN jsonb_build_object('ok', true, 'status', 'expired');
  ELSIF p_outcome = 'failed' THEN
    IF x.attempts >= 3 THEN
      UPDATE message_media SET status = 'failed', error = left(COALESCE(NULLIF(btrim(p_error), ''), 'failed'), 300), updated_at = now() WHERE id = x.id;
      RETURN jsonb_build_object('ok', true, 'status', 'failed');
    END IF;
    UPDATE message_media SET status = 'waiting', error = left(COALESCE(NULLIF(btrim(p_error), ''), 'failed'), 300), updated_at = now() WHERE id = x.id;
    RETURN jsonb_build_object('ok', true, 'status', 'waiting');
  END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'bad_outcome');
END;
$$;
