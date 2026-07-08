-- Real-time Gmail push (inbox Phase 3b, dev_task 094f7400).
--
-- Gmail users.watch → Pub/Sub topic gmail-push (GCP project
-- claude-gmail-connector-488713) → push subscription → POST
-- /api/webhooks/gmail-push (OIDC-verified). The webhook INSERTs a row here;
-- the dashboard subscribes via supabase_realtime and refetches unread
-- buckets. Rows are a WAKE-UP SIGNAL only — no email content is stored.

-- 1) Event stream ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gmail_push_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox text NOT NULL,                -- 'support' | 'antonio'
  email_address text NOT NULL,          -- as reported by Gmail
  history_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE gmail_push_events IS
  'Gmail push notifications (wake-up signals for the dashboard; no email content). Written by /api/webhooks/gmail-push, consumed via supabase_realtime, pruned by the gmail-watch-renew cron.';

CREATE INDEX IF NOT EXISTS idx_gmail_push_events_created
  ON gmail_push_events (created_at DESC);

-- Staff-only realtime: clients/partners must not receive these events.
ALTER TABLE gmail_push_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gmail_push_events_staff_select ON gmail_push_events;
CREATE POLICY gmail_push_events_staff_select ON gmail_push_events
  FOR SELECT TO authenticated
  USING (
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner')
  );

-- 2) Watch state (service-role only; RLS on, no policies) ---------------------
CREATE TABLE IF NOT EXISTS gmail_watch_state (
  mailbox text PRIMARY KEY,             -- 'support' | 'antonio'
  email_address text NOT NULL,
  history_id text,
  expiration timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE gmail_watch_state IS
  'Gmail users.watch registration state per mailbox. Watches expire ~7 days; the gmail-watch-renew cron re-registers daily.';

ALTER TABLE gmail_watch_state ENABLE ROW LEVEL SECURITY;

-- 3) Realtime publication (idempotent) ----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'gmail_push_events'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE gmail_push_events';
  END IF;
END $$;
