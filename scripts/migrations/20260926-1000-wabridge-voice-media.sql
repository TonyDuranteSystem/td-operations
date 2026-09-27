-- WhatsApp bridge (dev job 907b2535, child 06674723): VOICE NOTES — Phase 1, receive-only (listen + local transcript).
-- Antonio 2026-09-26: keep the audio 180 days (transcript permanent); transcribe EVERY incoming note automatically; comfortable recording/
-- transcribing leads' voice notes; only staff listen. Council-reviewed (system counselor, bug hunter, AI architect, project director).
--
-- WhatsApp keeps a voice note downloadable only ~19-26 days (measured on the real Mac 2026-09-26: 19 days ok, 26 days 410 Gone). So:
--   * a Mac job claims NEW notes within minutes; notes older than 25 days are marked 'expired' without asking the Mac (never re-polled);
--   * a claimed note that is not finished in 15 minutes becomes claimable again, at most 3 attempts, then 'failed'.
--
--   storage bucket 'wa-voice'      PRIVATE; 25 MB per file; only AAC/m4a audio types (enforced by the bucket, not by the client).
--                                  Nothing reads it except the server (signed URLs); playback goes through a staff-only route.
--   message_media                  ONE row per voice message: status waiting | processing | ready | expired | failed (validated in the functions —
--                                  NO CHECK constraints, the db-contract gate would flag new ones), the storage path (server-built, never chosen by
--                                  the Mac), duration, and the TRANSCRIPT in its OWN column — never in messages.content_text (which stays
--                                  "[Voice note]"), so it cannot leak into previews, search or the AI Worker. RLS on, no policies = service_role only.
--   wabridge_media_claim(channel)  hands the Mac ONE note (oldest recoverable first: the oldest expire first). Marks notes > 25 days 'expired'.
--   wabridge_media_finish(...)     the Mac's result. ready needs the server-built path; NEVER overwrites a ready row (a replay cannot replace audio or
--                                  transcript); expired is terminal; failed retries up to 3 attempts.
--   wabridge_media_expired_list / wabridge_media_mark_deleted   the 180-day retention sweep (delete the file, keep the transcript).
--
-- Sandbox: statement-by-statement via exec_sql. Production: Antonio runs it in the Supabase SQL editor.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('wa-voice', 'wa-voice', false, 26214400, ARRAY['audio/mp4', 'audio/x-m4a', 'audio/aac'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 26214400, allowed_mime_types = ARRAY['audio/mp4', 'audio/x-m4a', 'audio/aac'];

CREATE TABLE IF NOT EXISTS public.message_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES public.messaging_channels(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'voice',
  status text NOT NULL DEFAULT 'waiting',
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  storage_path text,
  mime_type text,
  size_bytes integer,
  duration_seconds integer,
  transcript text,
  transcript_language text,
  transcript_model text,
  error text,
  ready_at timestamptz,
  audio_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_media_channel_status_idx ON public.message_media (channel_id, status, claimed_at);
CREATE INDEX IF NOT EXISTS message_media_ready_idx ON public.message_media (ready_at) WHERE audio_deleted_at IS NULL AND storage_path IS NOT NULL;

ALTER TABLE public.message_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.message_media FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.message_media TO service_role;

CREATE OR REPLACE FUNCTION public.wabridge_media_claim(p_channel_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row record;
  v_media_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wabridge_media_claim:' || p_channel_id::text));

  -- WhatsApp no longer has the audio of anything older than ~25 days: record that once, never ask the Mac
  INSERT INTO message_media (message_id, channel_id, kind, status, error)
  SELECT m.id, m.channel_id, 'voice', 'expired', 'older than WhatsApp keeps voice notes'
  FROM messages m
  WHERE m.channel_id = p_channel_id AND m.content_type = 'voice' AND m.created_at < now() - interval '25 days'
    AND NOT EXISTS (SELECT 1 FROM message_media x WHERE x.message_id = m.id)
  ORDER BY m.created_at
  LIMIT 500
  ON CONFLICT (message_id) DO NOTHING;

  -- notes stuck in 'processing' for 15 minutes with the attempts used up: give up
  UPDATE message_media SET status = 'failed', error = COALESCE(error, 'gave up after 3 attempts'), updated_at = now()
  WHERE channel_id = p_channel_id AND status = 'processing' AND claimed_at < now() - interval '15 minutes' AND attempts >= 3;

  -- oldest recoverable first (the oldest expire first)
  SELECT m.id AS message_id, m.external_message_id, m.direction, m.created_at, g.external_group_id
    INTO v_row
  FROM messages m
  JOIN messaging_groups g ON g.id = m.group_id
  LEFT JOIN message_media x ON x.message_id = m.id
  WHERE m.channel_id = p_channel_id
    AND m.content_type = 'voice'
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
  VALUES (v_row.message_id, p_channel_id, 'voice', 'processing', 1, now())
  ON CONFLICT (message_id) DO UPDATE
    SET status = 'processing', attempts = message_media.attempts + 1, claimed_at = now(), updated_at = now()
  RETURNING id INTO v_media_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'message_id', v_row.message_id,
    'external_id', v_row.external_message_id,
    'chat_digits', regexp_replace(v_row.external_group_id, '\D', '', 'g'),
    'from_me', v_row.direction = 'outbound',
    'created_at', v_row.created_at,
    'path', 'voice/' || p_channel_id::text || '/' || v_row.message_id::text || '.m4a'
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
  v_path text := 'voice/' || p_channel_id::text || '/' || p_message_id::text || '.m4a';
BEGIN
  SELECT * INTO x FROM message_media WHERE message_id = p_message_id AND channel_id = p_channel_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF x.status = 'ready' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', 'ready'); -- a replay can never replace audio or transcript
  END IF;
  IF x.status <> 'processing' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_in_progress', 'status', x.status);
  END IF;

  IF p_outcome = 'ready' THEN
    IF p_path IS DISTINCT FROM v_path THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_path');
    END IF;
    IF p_size IS NULL OR p_size < 1 OR p_size > 26214400 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_size');
    END IF;
    UPDATE message_media SET
      status = 'ready', storage_path = v_path, mime_type = left(COALESCE(p_mime, 'audio/mp4'), 60), size_bytes = p_size,
      duration_seconds = GREATEST(COALESCE(p_duration, 0), 0),
      transcript = NULLIF(left(COALESCE(p_transcript, ''), 50000), ''),
      transcript_language = NULLIF(left(COALESCE(p_language, ''), 12), ''),
      transcript_model = NULLIF(left(COALESCE(p_model, ''), 80), ''),
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

-- the 180-day retention sweep: list what to delete, the route removes the files, then marks them
CREATE OR REPLACE FUNCTION public.wabridge_media_expired_list(p_days integer DEFAULT 180, p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('message_id', message_id, 'path', storage_path)), '[]'::jsonb)
  FROM (
    SELECT message_id, storage_path FROM message_media
    WHERE status = 'ready' AND audio_deleted_at IS NULL AND storage_path IS NOT NULL
      AND ready_at < now() - make_interval(days => GREATEST(p_days, 30))
    ORDER BY ready_at
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
  ) t;
$$;

CREATE OR REPLACE FUNCTION public.wabridge_media_mark_deleted(p_message_ids uuid[]) RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE message_media SET audio_deleted_at = now(), storage_path = NULL, updated_at = now()
  WHERE message_id = ANY (COALESCE(p_message_ids, '{}')) AND audio_deleted_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_media_claim(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_media_claim(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_media_finish(uuid, uuid, text, text, text, integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_media_finish(uuid, uuid, text, text, text, integer, integer, text, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_media_expired_list(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_media_expired_list(integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_media_mark_deleted(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_media_mark_deleted(uuid[]) TO service_role;
