-- Per-person "mark done" for a client conversation's mentions (floating chat).
--
-- Antonio, 2026-09-05, right after the ever_mentioned fix shipped: "in the
-- floating chat, after reading a message I want the option to mark it done
-- and disappear from the list." Confirmed: it should reappear if he is
-- mentioned again in that same conversation later (not hidden forever).
--
-- This is deliberately its OWN sparse table, not a reuse of
-- internal_thread_reads or internal_thread_later:
--   - internal_thread_reads.last_read_at defaults to now() on insert and is
--     also the participation/push-target signal — the exact epoch-seeding
--     hazard that broke the ever_opened attempt at this same list earlier
--     today (see docs/systems/team-workspace.md).
--   - internal_thread_later is presence-only ("parked, come back to it") and
--     explicitly documented as orthogonal to read/mention state — a
--     different verb, not a marker whose TIMESTAMP matters.
-- Here the timestamp is load-bearing: a mention dismisses the thread only
-- until a NEWER mention arrives, so re-dismissing must advance the stamp,
-- not just record presence.

CREATE TABLE IF NOT EXISTS public.internal_thread_mention_dismissals (
  thread_id    uuid NOT NULL REFERENCES public.internal_threads(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

-- Personal, short, cross-conversation marker → index by person (mirrors
-- idx_internal_thread_later_user's rationale).
CREATE INDEX IF NOT EXISTS idx_internal_thread_mention_dismissals_user
  ON public.internal_thread_mention_dismissals (user_id);

ALTER TABLE public.internal_thread_mention_dismissals ENABLE ROW LEVEL SECURITY;

-- Staff-only, mirroring internal_thread_later's policy shape.
DROP POLICY IF EXISTS internal_thread_mention_dismissals_staff ON public.internal_thread_mention_dismissals;
CREATE POLICY internal_thread_mention_dismissals_staff ON public.internal_thread_mention_dismissals
  FOR ALL TO authenticated
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner'))
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner'));
