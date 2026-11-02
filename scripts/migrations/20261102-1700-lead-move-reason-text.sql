-- Dev job 6fc63c52: keep the plain-words reason with every automatic Call Done move (and every "would have moved" record),
-- so the lead can always show WHY it moved, exactly as it was decided and not rebuilt later.
-- Re-runnable. Undo no longer uses undo_until (no clock); the column stays for old rows.

ALTER TABLE public.lead_status_moves ADD COLUMN IF NOT EXISTS reason_text text;
ALTER TABLE public.lead_status_moves ADD COLUMN IF NOT EXISTS evidence jsonb;
