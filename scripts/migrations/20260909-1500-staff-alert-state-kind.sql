-- Add a discriminator column to staff_alert_state so a note can carry more than one
-- independently-dismissible non-reply alert kind (note_update today; note_snooze_due new).
--
-- Before this migration, staff_alert_state_note_uq (user_id, note_id) WHERE reply_id IS NULL
-- gave exactly ONE slot per (user, note) for any non-reply dismissal — note_update already
-- owned it. Reusing that same slot for a second kind (the naive approach) would make
-- dismissing one alert silently also dismiss the other, since both would read/write the
-- identical row. Caught in council review (ai-architect + system-counselor, both
-- independently, dev job b85fe89e) before any code shipped against the old shape.
--
-- Reply-scoped rows (reply_id IS NOT NULL) are already uniquely disambiguated by reply_id
-- itself and don't strictly need `kind` to avoid a collision, but every row gets a real,
-- correct value (never a placeholder) so the column is never misleading if inspected directly.

ALTER TABLE public.staff_alert_state ADD COLUMN IF NOT EXISTS kind text;

UPDATE public.staff_alert_state
  SET kind = CASE WHEN reply_id IS NOT NULL THEN 'note_reply' ELSE 'note_update' END
  WHERE kind IS NULL;

ALTER TABLE public.staff_alert_state
  ALTER COLUMN kind SET NOT NULL;

ALTER TABLE public.staff_alert_state
  ADD CONSTRAINT staff_alert_state_kind_check
  CHECK (kind IN ('note_reply', 'note_update', 'note_snooze_due'));

-- Replace the old single-column partial index with one that also keys on kind, so
-- note_update and note_snooze_due each get their own dismissal slot per (user, note).
DROP INDEX IF EXISTS public.staff_alert_state_note_uq;
CREATE UNIQUE INDEX IF NOT EXISTS staff_alert_state_note_uq
  ON public.staff_alert_state (user_id, note_id, kind)
  WHERE reply_id IS NULL;
