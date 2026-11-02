-- Lead window: "Follow-up sent" mark (dev job 6fc63c52, Antonio 2026-11-02 "yes" to the tag in the Leads table).
-- When a follow-up leaves the Leads window the lead keeps WHEN and ON WHICH CHANNEL. Two plain columns, no CHECK list
-- (the channel values live in code: lib/leads/follow-up-sent.ts). Idempotent. The code works before this runs
-- (the Leads table and the window just show no tag), so it can be run on production before or after the merge.
-- UNDO: scripts/migrations/20261102-0100-lead-follow-up-sent.UNDO.sql

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS last_follow_up_sent_at timestamptz;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS last_follow_up_channel text;

-- verify
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'leads' AND column_name IN ('last_follow_up_sent_at', 'last_follow_up_channel')
 ORDER BY column_name;
