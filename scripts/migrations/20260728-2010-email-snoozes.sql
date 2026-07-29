-- Email snooze (Gmail has no API snooze — ours is label moves + this table).
-- One active snooze per thread per mailbox. The unsnooze cron acts ONLY on
-- rows here, never by sweeping the "Snoozed" Gmail label (which predates the
-- feature and may carry manually-filed threads; sandbox + production share the
-- same real mailboxes, so each environment's cron may only touch its own rows).
-- PLAIN unique constraint on purpose: a PARTIAL unique index breaks
-- supabase-js onConflict upserts (42P10 — the members-table incident).
CREATE TABLE IF NOT EXISTS email_snoozes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox text NOT NULL,
  thread_id text NOT NULL,
  snooze_until timestamptz NOT NULL,
  -- newest Gmail message id at snooze time: the cron cancels the wake if newer
  -- mail arrived (the reply already re-surfaced the thread, Gmail-parity)
  snoozed_last_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CONSTRAINT uq_email_snoozes_thread UNIQUE (mailbox, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_email_snoozes_due ON email_snoozes (snooze_until);

-- Server-only table (service role); web roles get nothing.
ALTER TABLE email_snoozes ENABLE ROW LEVEL SECURITY;
