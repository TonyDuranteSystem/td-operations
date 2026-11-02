-- UNDO for 20261102-0100-lead-follow-up-sent.sql. Drops the two columns (the marks are lost; the sent messages are not).
ALTER TABLE public.leads DROP COLUMN IF EXISTS last_follow_up_sent_at;
ALTER TABLE public.leads DROP COLUMN IF EXISTS last_follow_up_channel;
