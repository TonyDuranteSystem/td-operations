-- Worker WS0 safety batch 2 (council redo, dev job a9477d06).
-- Two independent structural guards for the CRM/Slack worker:
--
-- (1) DOUBLE-SEND IDEMPOTENCY (worker_send_markers)
--     A stuck worker turn (>10 min "processing") is recovered to "pending" by
--     the Slack cron and re-run from scratch; the client-facing send happens
--     mid-loop, so a re-run re-sends the SAME message/email to a real client.
--     The 2-minute content dedup has expired by the 10-minute recovery, so it
--     does not catch this. This table gives each (originating message, kind,
--     target, content) a one-time marker enforced by a DB unique index — the
--     R098 pattern (constraint, not a code check). A re-run inserts the same
--     marker, hits the unique violation, and skips the send.
--
-- (2) PER-THREAD IN-FLIGHT LOCK (partial unique index on agent_messages)
--     Two staff (or two quick messages) on the SAME worker thread each insert a
--     "processing" agent_messages row and run concurrently, interleaving one
--     conversation and letting the thread-summary write clobber blind. A partial
--     unique index allows at most ONE in-flight worker turn per thread; the
--     second insert fails and the route returns "worker busy on this thread".
--     Scoped to recipient='worker' (the CRM Inbox/Portal panels) so the Slack
--     (recipient='claude') pipeline — already serialized by its cron — is
--     untouched.

-- ── (1) worker_send_markers ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker_send_markers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_message_id uuid NOT NULL,
  kind              text NOT NULL,            -- 'portal_message' | 'email'
  target            text NOT NULL DEFAULT '', -- recipient id/address (observability + key)
  content_hash      text NOT NULL,            -- so a genuine 2nd distinct send in one turn is allowed
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The idempotency key: same originating row + same kind + same recipient + same
-- content = the same send. A re-run reproduces all four → blocked. Two DIFFERENT
-- messages in one legitimate turn differ on content_hash → both allowed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_send_marker
  ON worker_send_markers (source_message_id, kind, target, content_hash);

-- Housekeeping index for any future age-based cleanup.
CREATE INDEX IF NOT EXISTS idx_worker_send_markers_created
  ON worker_send_markers (created_at);

-- ── (2) per-thread in-flight lock ──────────────────────────────────────────
-- Defensive: clear any long-stuck in-flight worker rows first so the unique
-- index can be created (a crashed CRM turn leaves a 'processing' row that no
-- cron recovers — the route's own stale-sweep will handle these going forward).
UPDATE agent_messages
   SET status = 'failed', updated_at = now()
 WHERE status = 'processing'
   AND recipient = 'worker'
   AND COALESCE(claimed_at, created_at) < now() - interval '10 minutes';

CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_inflight_per_thread
  ON agent_messages (thread_id)
  WHERE status = 'processing' AND recipient = 'worker';
