-- Worker "prepared send" — the confirm step for an email the Inbox worker
-- composed WITH an attachment.
--
-- The worker never sends a file directly. When it's told to reply with an
-- attached file, it writes a row here (status='pending') and the panel shows a
-- Confirm/Cancel button built from THIS row (server-authored, not the model's
-- words). Only an explicit staff click on /confirm-send flips it to 'sent' and
-- actually dispatches — the human, not the model, is the second gate.
--
-- Everything needed to dispatch is frozen here at prepare time, so the send is
-- the exact payload the staff confirmed, never a re-draft. Recipient and each
-- attachment path are STILL re-validated at confirm time (recipient must still be
-- on the thread; path must still be a valid worker-upload path) — defence in depth.
--
-- Attachments store the private-bucket PATH, never bytes. Text-only worker sends
-- do NOT use this table (they send immediately, recipient-pinned) — this exists
-- only for the file case.

CREATE TABLE IF NOT EXISTS worker_prepared_sends (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_uuid    uuid NOT NULL,                       -- the worker thread (agent_messages.thread_id)
  gmail_thread_id text,                               -- reply threading target (nullable = new message)
  mailbox        text NOT NULL,                       -- support@ / antonio@ — the send runs as this user
  reply_to_message_id text,                           -- keeps the reply in-thread
  to_address     text NOT NULL,                       -- pinned recipient(s), validated again at confirm
  subject        text NOT NULL,
  body           text NOT NULL,                       -- plain text; the worker's branded HTML is rebuilt at send
  attachments    jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ path, name, content_type, size }]
  actor          text NOT NULL,                       -- staff member who will confirm (audit)
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,                         -- when it went sent/cancelled
  gmail_message_id text                               -- set on successful send
);

-- The panel polls for the latest pending row on a thread.
CREATE INDEX IF NOT EXISTS idx_worker_prepared_sends_thread_pending
  ON worker_prepared_sends (thread_uuid, created_at DESC)
  WHERE status = 'pending';
