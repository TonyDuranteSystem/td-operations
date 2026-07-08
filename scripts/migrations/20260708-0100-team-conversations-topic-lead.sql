-- Team Workspace — native "New conversation" support.
-- Lets a client discussion carry a TOPIC (from the topic_templates catalog or a
-- free-typed one) and optionally anchor to a LEAD (the client picker searches
-- accounts + contacts + leads, mirroring the Slack Client-Threads modal).
-- Additive only; safe on sandbox and prod.

BEGIN;

ALTER TABLE public.internal_threads
  ADD COLUMN IF NOT EXISTS topic       text,
  ADD COLUMN IF NOT EXISTS topic_slug  text,
  ADD COLUMN IF NOT EXISTS lead_id     uuid;

-- Find/reuse an open discussion for a given client+topic quickly.
CREATE INDEX IF NOT EXISTS idx_internal_threads_client_topic
  ON public.internal_threads (account_id, contact_id, lead_id, topic_slug)
  WHERE thread_type = 'discussion';

COMMIT;
