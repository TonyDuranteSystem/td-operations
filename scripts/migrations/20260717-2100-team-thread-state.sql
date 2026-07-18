-- Team Workspace — per-thread management state (status + assignee).
--
-- Lets staff manage each in-channel Slack thread so none get lost: mark a thread
-- Working / Pending / Done and optionally assign it. SPARSE — a row exists only
-- once a thread's status/assignee is set off the default. An untriaged thread
-- (no row) reads as the default status with no pill. "New" is NOT stored here —
-- it is derived from the per-thread unread signal (internal_root_reads), an
-- ORTHOGONAL badge painted on top of whatever status a thread has (so a Done
-- thread that gets a new reply resurfaces with a New badge instead of hiding).
--
-- Same status vocabulary as the conversation kanban (internal_threads.work_status)
-- but a DIFFERENT grain: this is per root MESSAGE (a thread inside a channel),
-- not per whole conversation. Deliberately its own table + endpoint so a per-root
-- "Done" can never be cross-wired into the whole-channel resolve path.

CREATE TABLE IF NOT EXISTS public.internal_thread_state (
  root_message_id uuid PRIMARY KEY REFERENCES public.internal_messages(id) ON DELETE CASCADE,
  thread_id       uuid NOT NULL REFERENCES public.internal_threads(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'todo'
                    CHECK (status IN ('todo', 'in_progress', 'waiting', 'handled')),
  assignee_id     uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);

CREATE INDEX IF NOT EXISTS idx_internal_thread_state_thread
  ON public.internal_thread_state (thread_id);

-- Staff-only RLS, mirroring the sibling internal_* tables.
ALTER TABLE public.internal_thread_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'internal_thread_state'
       AND policyname = 'internal_thread_state_staff_all'
  ) THEN
    CREATE POLICY internal_thread_state_staff_all
      ON public.internal_thread_state
      FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;
END $$;

-- Realtime so a status/assignee change reflects live for everyone (avoids two
-- people grabbing the same thread).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'internal_thread_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_thread_state;
  END IF;
END $$;
