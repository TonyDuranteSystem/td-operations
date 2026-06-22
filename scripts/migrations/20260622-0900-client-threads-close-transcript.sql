-- Client Threads — close + frozen transcript (dev_task 54f89912)
-- When a conversation is CLOSED, snapshot the full thread into `transcript` so it's a
-- permanent record (readable even if the Slack thread is later deleted). `status`
-- already exists (default 'open'); closing sets status='closed' + closed_at.
--
-- Additive, safe. Apply to sandbox via the sandbox MCP (one stmt each) or
-- apply-migration.js; promote to production in the Supabase SQL editor.

ALTER TABLE public.client_threads ADD COLUMN IF NOT EXISTS transcript jsonb;
ALTER TABLE public.client_threads ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE public.client_threads ADD COLUMN IF NOT EXISTS closed_by uuid;
