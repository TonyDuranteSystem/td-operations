-- Two independent fixes, one migration, because Antonio runs prod DDL by hand
-- and one step beats two.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. PER-PERSON NOTE STATE (staff_note_state)
--
-- Antonio, 2026-07-23: "when I create a note for Luca, I have to click Done to
-- make it disappear. When I click Done, it disappears also for Luca, so Luca and
-- I are two different things."
--
-- He is right, and it is worse than reported: `archived_at` AND `snoozed_until`
-- are single columns on the note row, so BOTH are shared. Whoever acts, acts for
-- everyone — including snoozing a shared note out of the other person's sight
-- and back into it at a time they never chose.
--
-- A note is ONE thing (body, client, colour — edited by either of them). "I have
-- dealt with this" is PER PERSON. That is the split this table makes.
--
-- Sparse by design: a row exists only once someone has done or snoozed a note.
-- No row = live for that person.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. PER-PERSON THREAD "LATER" (internal_thread_later)
--
-- Parking a conversation you have never opened MARKS IT READ. `later` lives on
-- internal_thread_reads, whose `last_read_at` defaults to now(), so the insert
-- that records "park this" also stamps "read everything in it". Antonio's own
-- stated use case — "something that stays pending" — silently loses its unread.
--
-- The obvious repair (write last_read_at back to the epoch in the same upsert)
-- is WRONG: the merge path would clobber a real, advanced read pointer and
-- resurface everything the user had genuinely read.
--
-- The repo already solved this exact problem one grain down: internal_root_later
-- (20260718-1700) is a sparse table created because "last_read_at DEFAULTS to
-- now(), so flagging Later on a thread you have never opened would create a read
-- row that marks its existing replies READ". The THREAD grain never got the same
-- treatment. This is that fix, deliberately mirroring the sibling table.
--
-- A read row is also PARTICIPATION (the discussion push branch targets whoever
-- holds one), so the seed-a-read-row approach would additionally subscribe you
-- to a conversation's phone alerts forever, with no way off. Another reason the
-- flag needs its own home.
--
-- SANDBOX FIRST (ref xjcxlmlpeywtwkhstjlw). Production only on Antonio's word.

BEGIN;

-- ── 1. Per-person note state ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_note_state (
  note_id       uuid NOT NULL REFERENCES public.staff_notes(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- when THIS person marked it done (null = still live for them)
  archived_at   timestamptz,
  -- when it should come back for THIS person (null = not snoozed by them)
  snoozed_until timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, user_id)
);

-- The read path is "everything not dealt with by ME", so index by person.
CREATE INDEX IF NOT EXISTS idx_staff_note_state_user
  ON public.staff_note_state (user_id);

-- Same posture as staff_notes itself: RLS on, NO policy, so a direct
-- anon/authenticated read returns zero rows. The app reads via the service-role
-- client behind requireStaff() + the visibility predicate.
ALTER TABLE public.staff_note_state ENABLE ROW LEVEL SECURITY;

-- ── BACKFILL: preserve exactly what is on screen today ──────────────────────
--
-- Every note currently done or snoozed must stay that way for EVERYONE who can
-- currently see it — otherwise flipping to per-person state would resurface old
-- notes on someone's screen the moment this ships. Visibility mirrors
-- isNoteVisibleTo(): the author, plus the named recipient when shared, plus
-- every staff member when the note is team-wide.
INSERT INTO public.staff_note_state (note_id, user_id, archived_at, snoozed_until)
SELECT n.id, v.user_id, n.archived_at, n.snoozed_until
FROM public.staff_notes n
CROSS JOIN LATERAL (
  SELECT n.author_user_id AS user_id
  WHERE n.author_user_id IS NOT NULL
  UNION
  SELECT n.shared_with_user_id
  WHERE n.visibility = 'shared' AND n.shared_with_user_id IS NOT NULL
  UNION
  SELECT u.id
  FROM auth.users u
  WHERE n.visibility = 'team'
    AND COALESCE(u.raw_app_meta_data->>'role', '') NOT IN ('client', 'partner')
    AND u.banned_until IS NULL
) v
WHERE n.archived_at IS NOT NULL OR n.snoozed_until IS NOT NULL
ON CONFLICT (note_id, user_id) DO NOTHING;

-- NOTE ON THE OLD COLUMNS: staff_notes.archived_at / .snoozed_until are left in
-- place and are no longer written by the app. They are kept for one release as a
-- rollback path and as the backfill's source of truth; dropping them is a
-- separate, deliberate follow-up once this is proven in use. Do NOT start
-- writing them again — two sources of truth for "is this done" is precisely the
-- bug this migration exists to remove.

-- ── 2. Per-person thread "Later" ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.internal_thread_later (
  thread_id  uuid NOT NULL REFERENCES public.internal_threads(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

-- Presence = flagged. Personal, short, cross-channel list → index by person.
CREATE INDEX IF NOT EXISTS idx_internal_thread_later_user
  ON public.internal_thread_later (user_id);

ALTER TABLE public.internal_thread_later ENABLE ROW LEVEL SECURITY;

-- Staff-only, mirroring internal_root_later's policy shape.
DROP POLICY IF EXISTS internal_thread_later_staff ON public.internal_thread_later;
CREATE POLICY internal_thread_later_staff ON public.internal_thread_later
  FOR ALL TO authenticated
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner'))
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner'));

-- BACKFILL: carry across anyone who has already parked a conversation, so the
-- Later list does not empty itself on deploy.
INSERT INTO public.internal_thread_later (thread_id, user_id)
SELECT thread_id, user_id
FROM public.internal_thread_reads
WHERE later IS TRUE
ON CONFLICT (thread_id, user_id) DO NOTHING;

-- internal_thread_reads.later is likewise left in place, unwritten, for one
-- release. get_team_threads still projects it; the follow-up that drops the
-- column must rewrite that function in the same change.

COMMIT;
