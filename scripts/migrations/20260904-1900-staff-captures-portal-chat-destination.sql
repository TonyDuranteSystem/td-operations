-- Capture/Share feature, Phase 2 — add portal_chat as a valid destination type.
--
-- Widens the CHECK added in 20260904-1500-staff-captures.sql from
-- ('sticky_note', 'team_chat') to also allow 'portal_chat'. Postgres has no
-- ALTER CONSTRAINT for a CHECK's expression, so this drops and re-adds it —
-- a pure widening, no existing row can violate the new (broader) list.
--
-- SANDBOX FIRST (ref xjcxlmlpeywtwkhstjlw). Council reviews the real diff
-- before production.

ALTER TABLE public.staff_captures
  DROP CONSTRAINT IF EXISTS staff_captures_destination_type,
  ADD CONSTRAINT staff_captures_destination_type CHECK (
    destination IS NULL OR destination->>'type' IN ('sticky_note', 'team_chat', 'portal_chat')
  );
