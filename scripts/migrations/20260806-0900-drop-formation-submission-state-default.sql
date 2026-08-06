-- WS-B scope amendment, Bug Hunter re-attack blocker (dev job c0a61e44):
-- formation_submissions.state carried DEFAULT 'NM', so the portal wizard submit
-- (which never sends state) let the SCHEMA bake a fake "decision" that outranked
-- the signed offer's pinned state in the resolution chain — resurrecting the
-- signed-Wyoming-files-as-NM bug on the primary client path.
--
-- Deliberately NO backfill/NULL-out of existing rows: a legacy 'NM' value may be
-- a real staff decision and is indistinguishable from a baked default. Legacy
-- deals keep their stored value; only NEW rows stop inheriting a fake decision.
-- (Same class as 20260716-1700-drop-tax-year-default.sql.)

ALTER TABLE formation_submissions ALTER COLUMN state DROP DEFAULT;
