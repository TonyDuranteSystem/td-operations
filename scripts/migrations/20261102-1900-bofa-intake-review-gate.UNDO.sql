-- Undo for 20261102-1900-bofa-intake-review-gate.sql: drops the review / send-back columns and the two address settings.
-- Only run it if nothing has been reviewed or sent back yet (the columns hold that history).
DROP INDEX IF EXISTS public.bofa_intake_one_live_replacement_idx;
ALTER TABLE public.bofa_intake_requests
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS sent_by,
  DROP COLUMN IF EXISTS sent_to,
  DROP COLUMN IF EXISTS returned_at,
  DROP COLUMN IF EXISTS returned_by,
  DROP COLUMN IF EXISTS return_note,
  DROP COLUMN IF EXISTS replaces_id,
  DROP COLUMN IF EXISTS staff_note;
DELETE FROM public.app_settings WHERE key IN ('bofa_submit_to', 'bofa_notify_to');
