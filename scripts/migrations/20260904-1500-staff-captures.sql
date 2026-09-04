-- Staff screenshot captures — the capture log (Capture/Share feature, step 1).
--
-- Every picture taken with the Capture tool writes one row here, regardless of
-- where it ends up (a sticky note today, a team-chat thread today, more
-- destinations in Phase 2). This is the single "my folder" index staff use to
-- find something they captured earlier.
--
-- Visibility: OWN CAPTURES ONLY (Antonio, explicit decision, 2026-09-04) — not
-- filtered by who can see the destination, just a flat rule: you only ever see
-- what you personally captured. Enforced the same way staff_notes is: RLS
-- enabled with NO policy, the app reads via the service-role client behind
-- requireStaff() and filters WHERE captured_by_user_id = the caller.
--
-- The image bytes themselves live in the PRIVATE worker-attachments Storage
-- bucket (never the public assets bucket — that bucket is a known, separately
-- tracked exposure, see dev_task 3e0578d9) under a captures/ prefix. This table
-- only stores a reference (image_url) + light metadata, matching the same
-- shape (url/name/mime_type/size) team-chat and portal-chat attachments already
-- use, so one shared upload function can feed any of this feature's
-- destinations and this log alike.
--
-- `destination` is set by a FOLLOW-UP update once the user finishes the
-- "Share to..." step (NULL right after a picture is captured/marked up, before
-- a destination is chosen) — polymorphic on purpose rather than a rigid
-- foreign key per destination type, since the destination list grows in
-- Phase 2. Only sticky_note/team_chat are valid today; a later migration
-- extends the allowed list when Phase 2 ships.
--
-- SANDBOX FIRST (ref xjcxlmlpeywtwkhstjlw). Council reviews the real diff
-- before production.

CREATE TABLE IF NOT EXISTS public.staff_captures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- who took it (auth user id + a denormalized display fallback, same pattern
  -- as staff_notes.author_*)
  captured_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  captured_by_name    text,

  -- the image itself lives in Storage; this is a reference + light metadata
  image_url           text NOT NULL,
  image_name          text,
  mime_type           text,
  size_bytes          bigint,

  title               text NOT NULL,
  note                text,

  -- where it was sent — NULL until the share step completes
  destination         jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Shape guards.
ALTER TABLE public.staff_captures
  ADD CONSTRAINT staff_captures_title_nonempty CHECK (char_length(btrim(title)) > 0),
  ADD CONSTRAINT staff_captures_image_url_nonempty CHECK (char_length(btrim(image_url)) > 0),
  ADD CONSTRAINT staff_captures_note_len CHECK (note IS NULL OR char_length(note) <= 4000),
  -- once set, a destination must at least name its type and the record it points at
  ADD CONSTRAINT staff_captures_destination_shape CHECK (
    destination IS NULL OR (destination ? 'type' AND destination ? 'id')
  ),
  -- Phase 1 destinations only; Phase 2 extends this list in its own migration.
  ADD CONSTRAINT staff_captures_destination_type CHECK (
    destination IS NULL OR destination->>'type' IN ('sticky_note', 'team_chat')
  );

-- The one real read path: "my captures, newest first."
CREATE INDEX IF NOT EXISTS idx_staff_captures_owner ON public.staff_captures (captured_by_user_id, created_at DESC);

-- RLS: deny all direct (non-service-role) access — same posture as staff_notes.
ALTER TABLE public.staff_captures ENABLE ROW LEVEL SECURITY;
-- (No permissive policy on purpose → anon/authenticated see nothing; service_role bypasses RLS.)

-- keep updated_at honest (destination is set by a follow-up update after insert)
CREATE OR REPLACE FUNCTION public.staff_captures_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_staff_captures_updated_at
  BEFORE UPDATE ON public.staff_captures
  FOR EACH ROW EXECUTE FUNCTION public.staff_captures_touch_updated_at();
