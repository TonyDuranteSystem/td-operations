-- UNDO for 20261108-1730-contract-version-voice-notes.sql: new offers go back to the first stamped version.
-- Offers already stamped '2026-11-08' keep their stamp (and their wording) — this only changes what NEW offers get.
ALTER TABLE public.offers ALTER COLUMN contract_version SET DEFAULT '2026-09-30';
