-- The WhatsApp program on the Mac now updates itself every night and reports what happened (updated / rolled back / needs a person).
-- These two columns hold the LAST report so the Inbox WhatsApp banner can show it. Nullable, no default, no backfill: a channel that has
-- never reported simply shows nothing. The application tolerates the columns being absent (the report is dropped, the banner stays quiet).
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS update_status jsonb;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS update_status_at timestamptz;
