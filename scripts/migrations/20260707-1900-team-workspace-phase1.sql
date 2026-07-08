-- Team Workspace — Phase 1 schema
-- Goal: turn the internal team chat (internal_threads/internal_messages) into a
-- full Slack-replacement workspace: channels + DMs + client discussions, with
-- reactions, edit history, pins, @mentions, colored rich cards, and a real
-- PER-USER read model (the old single read_at column made unread counts always 0).
--
-- Design notes / safety:
--   * Purely ADDITIVE (ADD COLUMN IF NOT EXISTS / CREATE IF NOT EXISTS). No data
--     is dropped; existing rows keep working. Safe to run on sandbox AND prod.
--   * Backfills thread_type for the existing __team_general__ room ('general')
--     and every existing account/contact thread ('discussion').
--   * Prod has RLS ENABLED on internal_* (staff-only: role<>client); sandbox has
--     it OFF. The new internal_thread_reads table replicates the SAME staff-only
--     policy so behaviour matches prod. (A green sandbox test does NOT prove RLS.)
--   * Adds internal_threads + internal_thread_reads to the supabase_realtime
--     publication so the channel/DM list updates live (internal_messages already
--     is a member).
--   * New RPC toggle_internal_message_reaction mirrors the existing
--     toggle_message_reaction (which is hardcoded to portal_messages and must NOT
--     be touched).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. internal_threads: thread typing + channel/DM metadata
-- ---------------------------------------------------------------------------
ALTER TABLE public.internal_threads
  ADD COLUMN IF NOT EXISTS thread_type   text NOT NULL DEFAULT 'discussion',
  ADD COLUMN IF NOT EXISTS channel_name  text,
  ADD COLUMN IF NOT EXISTS channel_slug  text,
  ADD COLUMN IF NOT EXISTS description   text,
  ADD COLUMN IF NOT EXISTS color         text,
  ADD COLUMN IF NOT EXISTS dm_key        text,
  ADD COLUMN IF NOT EXISTS archived_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

-- thread_type domain: 'general' | 'channel' | 'discussion' | 'dm'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'internal_threads_thread_type_chk'
  ) THEN
    ALTER TABLE public.internal_threads
      ADD CONSTRAINT internal_threads_thread_type_chk
      CHECK (thread_type IN ('general','channel','discussion','dm'));
  END IF;
END $$;

-- Backfill existing rows: the general room, then everything else = discussion.
UPDATE public.internal_threads
   SET thread_type = 'general'
 WHERE title = '__team_general__' AND thread_type <> 'general';

UPDATE public.internal_threads
   SET thread_type = 'discussion'
 WHERE title IS DISTINCT FROM '__team_general__'
   AND thread_type NOT IN ('general','channel','dm');

-- Seed last_activity_at from the newest message (fallback to created_at) so the
-- list sorts correctly from day one.
UPDATE public.internal_threads t
   SET last_activity_at = COALESCE(
     (SELECT max(m.created_at) FROM public.internal_messages m WHERE m.thread_id = t.id),
     t.created_at
   )
 WHERE t.last_activity_at IS NULL;

-- Unique channel slug (only where set). Partial unique index tolerates the many
-- NULLs on discussion/dm/general rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_internal_threads_channel_slug
  ON public.internal_threads (channel_slug)
  WHERE channel_slug IS NOT NULL;

-- One DM thread per unordered pair of users.
CREATE UNIQUE INDEX IF NOT EXISTS uq_internal_threads_dm_key
  ON public.internal_threads (dm_key)
  WHERE dm_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_internal_threads_type_activity
  ON public.internal_threads (thread_type, last_activity_at DESC);

-- ---------------------------------------------------------------------------
-- 2. internal_messages: reactions, edit history, pins, mentions, rich cards
-- ---------------------------------------------------------------------------
ALTER TABLE public.internal_messages
  ADD COLUMN IF NOT EXISTS reactions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS edited_at        timestamptz,
  ADD COLUMN IF NOT EXISTS original_message text,
  ADD COLUMN IF NOT EXISTS pinned_at        timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_by        uuid,
  ADD COLUMN IF NOT EXISTS mentions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS card             jsonb;

-- Pinned-messages lookup per thread.
CREATE INDEX IF NOT EXISTS idx_internal_messages_pinned
  ON public.internal_messages (thread_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Per-user read state (fixes always-zero unread; supports channels + DMs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.internal_thread_reads (
  thread_id    uuid NOT NULL REFERENCES public.internal_threads(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_thread_reads_user
  ON public.internal_thread_reads (user_id);

-- Match prod's staff-only RLS on the sibling internal_* tables. Harmless on
-- sandbox (RLS off there); correct on prod.
ALTER TABLE public.internal_thread_reads ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'internal_thread_reads'
       AND policyname = 'internal_thread_reads_staff_all'
  ) THEN
    CREATE POLICY internal_thread_reads_staff_all
      ON public.internal_thread_reads
      FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Reaction toggle RPC for internal_messages
--    (mirror of toggle_message_reaction, which is bound to portal_messages)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.toggle_internal_message_reaction(
  p_message_id   uuid,
  p_emoji        text,
  p_reactor_id   text,
  p_reactor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  current_reactions jsonb;
  new_reactions     jsonb;
  was_removed       boolean;
BEGIN
  SELECT COALESCE(reactions, '[]'::jsonb)
    INTO current_reactions
    FROM internal_messages
   WHERE id = p_message_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'message_not_found';
  END IF;

  new_reactions := COALESCE((
    SELECT jsonb_agg(elem)
      FROM jsonb_array_elements(current_reactions) elem
     WHERE NOT (elem->>'emoji' = p_emoji AND elem->>'reactor_id' = p_reactor_id)
  ), '[]'::jsonb);

  was_removed := jsonb_array_length(current_reactions) <> jsonb_array_length(new_reactions);

  IF NOT was_removed THEN
    new_reactions := new_reactions || jsonb_build_object(
      'emoji',        p_emoji,
      'reactor_id',   p_reactor_id,
      'reactor_name', p_reactor_name,
      'created_at',   now()
    );
  END IF;

  UPDATE internal_messages
     SET reactions = new_reactions
   WHERE id = p_message_id;

  RETURN jsonb_build_object('reactions', new_reactions, 'added', NOT was_removed);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Realtime: channel/DM list needs thread + read-state change events
--    (internal_messages is already a publication member)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       AND tablename = 'internal_threads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_threads;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       AND tablename = 'internal_thread_reads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_thread_reads;
  END IF;
END $$;

COMMIT;
