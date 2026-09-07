-- Staff Alerts — per-person dismiss state for note-sourced alerts (replies, shares/edits).
-- Read side is DERIVED at request time from staff_notes / staff_note_replies (no copy of the
-- alert content is stored) — this table records ONLY "user X dismissed this, as of when."
--
-- Two shapes share one table, kept apart by a nullable reply_id + two partial unique indexes:
--   reply_id SET      -> dismissal of one specific reply (staff_note_replies row)
--   reply_id NULL     -> dismissal of a note's "shared/updated" alert; re-dismissing after a
--                        later change just moves dismissed_at forward (upsert), which is how a
--                        fresh edit/share after a dismiss naturally reappears without a second row.
--
-- Same lockdown as staff_notes / staff_note_state: RLS enabled, NO policy — a direct
-- anon/authenticated PostgREST call sees nothing. Only the service-role client behind
-- requireStaff() in the API route reads/writes this.

CREATE TABLE IF NOT EXISTS public.staff_alert_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  note_id uuid NOT NULL REFERENCES public.staff_notes(id) ON DELETE CASCADE,
  reply_id uuid REFERENCES public.staff_note_replies(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_alert_state_reply_uq
  ON public.staff_alert_state (user_id, reply_id)
  WHERE reply_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS staff_alert_state_note_uq
  ON public.staff_alert_state (user_id, note_id)
  WHERE reply_id IS NULL;

CREATE INDEX IF NOT EXISTS staff_alert_state_user_idx
  ON public.staff_alert_state (user_id);

ALTER TABLE public.staff_alert_state ENABLE ROW LEVEL SECURITY;
-- Deliberately no policy — see header.
