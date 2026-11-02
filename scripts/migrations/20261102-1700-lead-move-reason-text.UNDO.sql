-- Undo for 20261102-1700-lead-move-reason-text.sql (only drops the two new, additive columns).
ALTER TABLE public.lead_status_moves DROP COLUMN IF EXISTS reason_text;
ALTER TABLE public.lead_status_moves DROP COLUMN IF EXISTS evidence;
