-- Follow-up to 20260731-2010: `draft_locale` is a CHOICE, not a detector verdict.
--
-- WHY THIS CHANGED, same day, before any code shipped. 20260731-2010 allowed
-- ('en','it','unknown') because the design at that moment ran the EN/IT draft detector
-- and stored its verdict — and that detector deliberately answers "unknown" on short
-- text (`lib/ai-agent/draft-language.ts`: fewer than 12 words, or fewer than 5
-- recognised words, returns unknown).
--
-- Antonio rejected that whole approach, 2026-07-31, verbatim:
--   "the system can't recognize the language, which is only bullshit, because Luca will
--    choose the language in the dropdown: Italian or English. When Luca chooses English,
--    Luca can also speak in Italian for the message, but the system will always go out in
--    English. If Luca chooses Italian in the card, but he will speak to the worker in
--    English, the worker will write in Italian."
--
-- So the value is the staff member's pick on the Confirm card, and it is an INSTRUCTION
-- to the worker ("write it in this language"), not an observation about the text. A human
-- always picked one, so 'unknown' can never be written — and a database that allows a
-- value the code never writes is exactly what the contract gate flags.
--
-- The detector is untouched and still governs the pinned direct-send surfaces (Portal
-- Chats, sidebar), which have no card and no dropdown.
--
-- Safe to run: no row can yet hold 'unknown' — the portal path is unbuilt, and every
-- pre-existing row is kind='email' with draft_locale NULL.

ALTER TABLE worker_prepared_sends
  DROP CONSTRAINT IF EXISTS worker_prepared_sends_draft_locale_check;

ALTER TABLE worker_prepared_sends
  ADD CONSTRAINT worker_prepared_sends_draft_locale_check
  CHECK (draft_locale IS NULL OR draft_locale IN ('en','it'));

COMMENT ON COLUMN worker_prepared_sends.draft_locale IS
  'en | it — the language the staff member CHOSE on the Confirm card, carried as an instruction to the worker. Never a detector verdict. NULL on an email row.';
