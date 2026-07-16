-- PTBT incident (dev job 8cc8e1c8): tax_return_submissions.tax_year carried
-- DEFAULT 2025 — a hard-coded filing year that goes stale every January and
-- silently stamps any submission whose caller failed to supply a year (the
-- mechanism that labeled a 2026-formed company's data as a 2025 return).
--
-- The wizard-submit route now ALWAYS supplies tax_year explicitly (pinned by
-- lib/tax/wizard-eligibility). NOT NULL stays: with no default, a code path
-- that fails to supply the year becomes a loud insert failure instead of a
-- plausible-looking wrong year.
--
-- PROD ORDER (council-mandated): push the code FIRST, run this AFTER.
-- Dropping the default first would make old code (which omits the column when
-- its lookup returns null) fail NOT NULL mid-flight — and the retry then hits
-- the wizard_progress dedup and reports a false "Already submitted".

ALTER TABLE tax_return_submissions ALTER COLUMN tax_year DROP DEFAULT;
