-- Team Workspace — Slack-style message threads.
--
-- Adds a stable per-message THREAD ROOT link + a per-user, per-thread read
-- pointer so channel messages can carry reply threads (like Slack) without the
-- two failure modes the council flagged on the naive client-side approach:
--   1. reply_to_id does not always point at a root (Claude answers / approvals
--      point at the prompt), and grouping over a capped client load is wrong.
--      -> root_id is stamped at insert on every write path = parent.root_id ?? parent.id.
--   2. one last_read_at per channel hides unread replies inside collapsed
--      threads. -> internal_root_reads gives a per-thread read pointer.
--
-- root_id is deliberately a PLAIN uuid (no FK): a future hard-delete of a root
-- must NOT null its replies' root_id (which would resurface them as loose
-- top-level messages). Grouping integrity > referential cascade. UI deletes are
-- soft, so the root row survives as a tombstone regardless.

-- ---------------------------------------------------------------------------
-- 1. Thread-root link on every message (NULL = the message IS a root)
-- ---------------------------------------------------------------------------
ALTER TABLE public.internal_messages
  ADD COLUMN IF NOT EXISTS root_id uuid;

CREATE INDEX IF NOT EXISTS idx_internal_messages_root
  ON public.internal_messages (thread_id, root_id)
  WHERE root_id IS NOT NULL;

-- Backfill existing replies: climb reply_to_id to the ultimate root (the
-- ancestor whose own reply_to_id IS NULL) and stamp it. Chains are shallow.
WITH RECURSIVE climb AS (
  SELECT m.id AS leaf, m.id AS node, m.reply_to_id AS parent
    FROM public.internal_messages m
   WHERE m.reply_to_id IS NOT NULL
  UNION ALL
  SELECT c.leaf, p.id, p.reply_to_id
    FROM climb c
    JOIN public.internal_messages p ON p.id = c.parent
   WHERE c.parent IS NOT NULL
),
resolved AS (
  SELECT leaf, node AS root_id
    FROM climb
   WHERE parent IS NULL
)
UPDATE public.internal_messages t
   SET root_id = r.root_id
  FROM resolved r
 WHERE t.id = r.leaf
   AND t.root_id IS DISTINCT FROM r.root_id;

-- ---------------------------------------------------------------------------
-- 2. Per-user, per-thread (per-root) read pointer — kills the missed-reply hole
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.internal_root_reads (
  root_message_id uuid NOT NULL REFERENCES public.internal_messages(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_root_reads_user
  ON public.internal_root_reads (user_id);

-- Staff-only RLS, mirroring the sibling internal_* tables (harmless on sandbox
-- where RLS is off; correct on prod).
ALTER TABLE public.internal_root_reads ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'internal_root_reads'
       AND policyname = 'internal_root_reads_staff_all'
  ) THEN
    CREATE POLICY internal_root_reads_staff_all
      ON public.internal_root_reads
      FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;
END $$;
