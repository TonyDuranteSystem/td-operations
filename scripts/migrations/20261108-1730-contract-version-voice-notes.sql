-- Contract version 2026-11-08 (dev job 753b2909, Antonio 2026-11-08): the client's microphone now records a real voice
-- note, so the Portal Chat lines of the contract say "voice notes" instead of "voice dictation".
--
-- ONLY offers created from now on carry the new version. Every offer that already exists keeps the version it was sent with
-- ('2026-09-30' or 'pre-versioning') and therefore the old wording, exactly as it was sent or signed. This file changes
-- the column DEFAULT only: it touches NO existing row.
--
-- ORDER (important): ship the code that knows the new version FIRST, run this AFTER. If the default moved first, a new
-- offer would be stamped 2026-11-08 while an older build still showed the old text under that label.
-- lib/offers/contract-version.ts CURRENT_CONTRACT_VERSION must equal the default below (a unit test pins it).
-- Idempotent.

ALTER TABLE public.offers ALTER COLUMN contract_version SET DEFAULT '2026-11-08';

-- Check
SELECT column_default FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'offers' AND column_name = 'contract_version';
