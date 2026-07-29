-- Replies inside staff sticky notes (dev job 91120722, Antonio 2026-07-29:
-- "when there is a reply in a note, I want the reply to be a different color to
-- distinguish... and a notification for the reply to the person who is sent to").
--
-- A reply is its own row with its own author — the note body stays the AUTHOR's
-- text (author-only to edit, enforced in the route via mayEditBody), everyone
-- else answers here. Visibility is INHERITED FROM THE PARENT note: whoever can
-- see the note sees all its replies (re-sharing a note exposes old replies to
-- the new person; making it private hides others' replies — accepted at 2 staff,
-- see docs/systems/staff-notes.md).
--
-- DELIBERATELY NO updated_at bump on the parent (council, 2026-07-29): bumping
-- broke the stale-edit guard (false 409 on the author's own next Save) and
-- silenced the edit push's burst guard. Reply activity is derived READ-SIDE
-- from the embedded rows (max created_at).
--
-- DEPLOY ORDER IS LOAD-BEARING: this migration runs BEFORE the code ships —
-- the note feeds embed this relation in their nested select, so code without
-- the table 500s every note screen (same as the staff_note_state precedent).
--
-- SANDBOX FIRST (ref xjcxlmlpeywtwkhstjlw). Antonio runs this on production in
-- the Supabase SQL editor before approving the code push.

CREATE TABLE IF NOT EXISTS public.staff_note_replies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- the note this answers; a hard-deleted note takes its replies with it
  note_id        uuid NOT NULL REFERENCES public.staff_notes(id) ON DELETE CASCADE,

  -- who answered (same shape as the parent: auth id + denormalized display fallback;
  -- SET NULL so deleting a user never blocks and never orphans into an error)
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  author_name    text,

  -- mirrors the parent body CHECKs so a friendly error can fire before Postgres does
  body           text NOT NULL CHECK (btrim(body) <> '' AND char_length(body) <= 4000),

  created_at     timestamptz NOT NULL DEFAULT now()
);

-- the one read path: all replies of a note, oldest first
CREATE INDEX IF NOT EXISTS idx_staff_note_replies_note
  ON public.staff_note_replies (note_id, created_at);

-- RLS: deny all direct (non-service-role) access — identical posture to
-- staff_notes and staff_note_state. The app reads via the service role behind
-- requireStaff() and the parent note's visibility predicate.
ALTER TABLE public.staff_note_replies ENABLE ROW LEVEL SECURITY;
-- (No permissive policy on purpose → anon/authenticated see nothing.)
