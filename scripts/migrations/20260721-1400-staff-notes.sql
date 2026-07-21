-- Staff floating sticky notes (pass 1) — the note store.
--
-- A dedicated, ISOLATED table (NOT message_actions). Rationale: Antonio's notes are
-- PRIVATE by default, and the To-Do board (message_actions) has 7+ readers with no per-user
-- visibility concept — the pass-1 council review found an unfiltered reader that would leak a
-- private note. A separate table means a private note physically cannot appear on the board,
-- the counts, or the entity-summary widget. Notes get their own floating display + their own
-- on-company-page widget, which is how they still "show on the company page" without
-- piggybacking on the board's readers. (This reverses the council's earlier "reuse
-- message_actions" steer, on purpose, because the private-notes decision changed the calculus.)
--
-- Visibility model (Antonio's decision — three levels, switch with a click):
--   'private'  → only the author sees it (default)
--   'shared'   → the author + exactly one other staff member (shared_with_user_id); this is
--                what "hand it to Luca" sets, and it pushes to that person's phone
--   'team'     → every staff member sees it
-- Canonical predicate (ONE place in code, imported by every reader): a note is visible to U iff
--   author_user_id = U  OR  visibility = 'team'  OR  (visibility = 'shared' AND shared_with_user_id = U)
--
-- Enforcement: the app reads via the service-role client behind requireStaff() + the predicate
-- above. RLS is ENABLED with NO permissive policy, so a direct anon/authenticated PostgREST
-- read (a client, or any non-service caller) returns ZERO rows — clients can never reach a
-- staff note. Service-role (the app) bypasses RLS; the predicate is the real filter. This is
-- the message_actions enforcement pattern, hardened: here RLS denies everyone but service-role.
--
-- SANDBOX FIRST (ref xjcxlmlpeywtwkhstjlw). Council reviews the real diff before production.

CREATE TABLE IF NOT EXISTS public.staff_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body                text NOT NULL,
  color               text NOT NULL DEFAULT 'yellow',

  -- who wrote it (auth user id + a denormalized display fallback)
  author_user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  author_name         text,

  -- three-level visibility
  visibility          text NOT NULL DEFAULT 'private',
  shared_with_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  shared_with_name    text,

  -- what it's about (captured from the page; nullable = a free note with no subject)
  account_id          uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  contact_id          uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  origin_url          text,

  snoozed_until       timestamptz,
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Length + shape guards (a length CHECK is NOT a catalog-slug CHECK, so the todo-board
-- no-CHECK invariant does not apply). Body must be non-empty and bounded so a pasted wall of
-- text can't become a full-screen note; visibility limited to the three known values.
ALTER TABLE public.staff_notes
  ADD CONSTRAINT staff_notes_body_nonempty CHECK (char_length(btrim(body)) > 0),
  ADD CONSTRAINT staff_notes_body_len CHECK (char_length(body) <= 4000),
  ADD CONSTRAINT staff_notes_visibility CHECK (visibility IN ('private','shared','team')),
  -- 'shared' MUST name a person; 'private'/'team' must NOT (keeps the two columns coherent so
  -- un-sharing can never leave a stale shared_with_user_id that keeps the note visible).
  ADD CONSTRAINT staff_notes_shared_coherent CHECK (
    (visibility = 'shared' AND shared_with_user_id IS NOT NULL) OR
    (visibility <> 'shared' AND shared_with_user_id IS NULL)
  );

-- Indexes for the three read paths (all scoped to live notes).
CREATE INDEX IF NOT EXISTS idx_staff_notes_author   ON public.staff_notes (author_user_id)      WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staff_notes_shared    ON public.staff_notes (shared_with_user_id)  WHERE archived_at IS NULL AND visibility = 'shared';
CREATE INDEX IF NOT EXISTS idx_staff_notes_account   ON public.staff_notes (account_id)           WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staff_notes_contact   ON public.staff_notes (contact_id)           WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staff_notes_team_live ON public.staff_notes (created_at DESC)       WHERE archived_at IS NULL AND visibility = 'team';

-- RLS: deny all direct (non-service-role) access. The app filters via the predicate above.
ALTER TABLE public.staff_notes ENABLE ROW LEVEL SECURITY;
-- (No permissive policy on purpose → anon/authenticated see nothing; service_role bypasses RLS.)

-- keep updated_at honest for stale-edit detection on body edits
CREATE OR REPLACE FUNCTION public.staff_notes_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_staff_notes_updated_at
  BEFORE UPDATE ON public.staff_notes
  FOR EACH ROW EXECUTE FUNCTION public.staff_notes_touch_updated_at();
