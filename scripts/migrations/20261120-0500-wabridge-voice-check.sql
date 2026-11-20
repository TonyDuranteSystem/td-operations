-- Weekly voice-note self-test + the red dot (2026-11-20, Antonio: "build 5 and 6").
-- voice_check:          the state of the latest weekly test (jsonb: week, status, sent_at, …) — written by the weekly job / the Yes-No buttons.
-- voice_check_group_id: which chat receives the test (Antonio's own phone). NULL = the weekly test is OFF (the default).
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS voice_check jsonb;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS voice_check_group_id uuid;
