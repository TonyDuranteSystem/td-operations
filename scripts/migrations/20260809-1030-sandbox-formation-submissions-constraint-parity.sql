-- Sandbox/production schema parity: formation_submissions constraints.
--
-- WHY: sandbox drifted. Production carries 7 constraints on this table; sandbox
-- carried 3 (primary key + 2 foreign keys). The missing UNIQUE (token) is the
-- ON CONFLICT target the portal's wizard-submit route upserts against, so EVERY
-- submit attempt in sandbox failed with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
-- That blocked submit-path QA for every wizard type in sandbox, not just
-- formation — found while QA'ing dev job fc69557f (MMLLC formation wizard),
-- 2026-08-09, Antonio approved the repair the same day.
--
-- The three CHECK constraints are added in the same pass so sandbox can also
-- catch bad values the way production would. NOTE: a CHECK passes NULL, so
-- entity_type = NULL (which the formation path now writes deliberately, rather
-- than fabricating 'SMLLC') satisfies the entity_type check on both sides.
--
-- PRE-FLIGHT VERIFIED IN SANDBOX BEFORE WRITING THIS FILE (17 rows):
--   0 duplicate tokens, 0 null tokens, 0 out-of-range entity_type / language /
--   status. So none of these can fail on existing data.
--
-- SANDBOX ONLY. Production already has all four — do NOT promote this file.

-- 1. The ON CONFLICT target the submit route depends on.
ALTER TABLE formation_submissions
  ADD CONSTRAINT formation_submissions_token_key UNIQUE (token);

-- 2. Value checks, matching production exactly.
ALTER TABLE formation_submissions
  ADD CONSTRAINT formation_submissions_entity_type_check
  CHECK (entity_type = ANY (ARRAY['SMLLC'::text, 'MMLLC'::text]));

ALTER TABLE formation_submissions
  ADD CONSTRAINT formation_submissions_language_check
  CHECK (language = ANY (ARRAY['en'::text, 'it'::text]));

ALTER TABLE formation_submissions
  ADD CONSTRAINT formation_submissions_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'opened'::text, 'completed'::text, 'reviewed'::text]));
