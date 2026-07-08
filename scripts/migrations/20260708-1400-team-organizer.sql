-- Team Workspace — organizer layer: channel-folders + kanban work status +
-- per-user mark-unread / "later" flags. Additive; safe on sandbox and prod.
--
-- Decisions (Antonio 2026-07-08):
--  * Channels are FOLDERS that hold threads → internal_threads.parent_channel_id
--    points at the channel a discussion/topic is filed under (null = unfiled).
--  * ONE kanban board of all threads → internal_threads.work_status
--    (todo/in_progress/waiting/handled); "handled" is the done state, replacing
--    the plain resolve toggle (resolved_at kept in sync for back-compat).
--  * Mark-unread + "Later" are PER-USER → internal_thread_reads flags.

BEGIN;

-- 1. Channel-folder parent + kanban status on threads.
ALTER TABLE public.internal_threads
  ADD COLUMN IF NOT EXISTS parent_channel_id uuid,
  ADD COLUMN IF NOT EXISTS work_status       text NOT NULL DEFAULT 'todo';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='internal_threads_work_status_chk') THEN
    ALTER TABLE public.internal_threads
      ADD CONSTRAINT internal_threads_work_status_chk
      CHECK (work_status IN ('todo','in_progress','waiting','handled'));
  END IF;
END $$;

-- Backfill: already-resolved threads become 'handled'; the rest 'todo'.
UPDATE public.internal_threads
   SET work_status = 'handled'
 WHERE resolved_at IS NOT NULL AND work_status <> 'handled';

-- Board + folder lookup indexes.
CREATE INDEX IF NOT EXISTS idx_internal_threads_work_status
  ON public.internal_threads (work_status)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_internal_threads_parent_channel
  ON public.internal_threads (parent_channel_id)
  WHERE parent_channel_id IS NOT NULL;

-- 2. Per-user mark-unread + "Later" flags.
ALTER TABLE public.internal_thread_reads
  ADD COLUMN IF NOT EXISTS manual_unread boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS later         boolean NOT NULL DEFAULT false;

COMMIT;
