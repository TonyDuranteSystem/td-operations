-- Staff sticky notes: an optional short title, separate from the note's own
-- text (body).
--
-- Antonio, 2026-09-08 (looking at the just-shipped header strip): "add the
-- option to write a title in the note creation" — the pill already shows a
-- slice of the body as its label and reveals the rest on hover, which he
-- flagged as a mediocre substitute for a real, deliberately-written short
-- label. Nullable and optional everywhere: every existing note has no
-- title, and forcing one on every future quick note would add friction to
-- the single most frequent action in this whole subsystem — exactly the
-- kind of regression closed earlier today (2026-09-08f/g entries in
-- docs/systems/staff-notes.md).
--
-- Deploy order is LOAD-BEARING for this table, same as every other change
-- to it today (staff-notes.md's own repeated lesson) — this migration MUST
-- be applied and VERIFIED LIVE in production, by querying the column, not
-- by trusting the deploy succeeded, before any code referencing `title`
-- ships to production.
--
-- Length cap (120) mirrors the existing 80-character budget the header
-- pill's own preview text already uses (active-notes-strip.tsx) — a title
-- is meant to be a short label, not a second body; the CHECK is a real
-- backstop, not just a UI hint, matching how staff_notes.body's own length
-- is already enforced identically at both layers (NOTE_BODY_MAX in
-- lib/notes/staff-notes.ts + the DB CHECK in the original 20260721 migration).

ALTER TABLE staff_notes ADD COLUMN title TEXT NULL;

ALTER TABLE staff_notes ADD CONSTRAINT staff_notes_title_len
  CHECK (title IS NULL OR char_length(title) <= 120);
