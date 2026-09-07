-- Staff sticky notes: add a fourth per-person state, "Parked" — a note that has
-- been moved to the dedicated header shelf, still visible/grouped, not hidden
-- (Done) and not scheduled for later (Snoozed).
--
-- Antonio, 2026-09-08: "'parked' button move it to the top" — a genuinely new
-- state, not a repurposed Snooze. Council + bug-hunter reviewed before build.
--
-- Mutual exclusivity is enforced at TWO layers, deliberately:
--  1. The application (app/api/crm/staff-notes/route.ts's setMyNoteState) now
--     explicitly nulls the other two fields whenever it writes any one of
--     archived_at/snoozed_until/parked_at, so a normal user action can never
--     produce an inconsistent row.
--  2. This CHECK constraint is the backstop for anything that bypasses the
--     app layer (a bad migration, a manual SQL fix, a future bug) — it does
--     not replace layer 1, which is what gives a normal user a real error
--     message instead of a raw constraint violation.
--
-- The bug-hunter's plan review found this exact gap ALREADY LIVE today between
-- archived_at and snoozed_until (a revived Done note's card still offers an
-- unconditional Snooze button, and clicking it left both fields set at once) —
-- this same migration and the paired application fix close that too.
--
-- Deploy order is LOAD-BEARING for this table (staff-notes.md's own repeated
-- lesson, failed twice already 2026-07-23 and 2026-09-04c): this migration
-- MUST be applied and VERIFIED LIVE in production — by querying the column,
-- not by trusting the deploy succeeded — before any code referencing
-- parked_at ships to production.

ALTER TABLE staff_note_state ADD COLUMN parked_at TIMESTAMPTZ NULL;

ALTER TABLE staff_note_state ADD CONSTRAINT staff_note_state_one_status_check
  CHECK (
    (CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN snoozed_until IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN parked_at IS NOT NULL THEN 1 ELSE 0 END) <= 1
  );
