-- code_task_questions — the ask_antonio interactive loop (Slack → Mac Mini rail).
--
-- A running headless code-task session can pause and ask Antonio a question in
-- the originating Slack thread, then wait for his reply before continuing. One
-- row per question:
--   - the ask-antonio CLI (scripts/mac-mini/ask-antonio.mjs, run by the session)
--     INSERTs a row (status='pending') and posts the question to Slack, then
--     polls this row until status='answered'.
--   - the Slack webhook (app/api/webhooks/slack-claude/route.ts) intercepts
--     Antonio's thread reply, UPDATEs the matching pending row to 'answered',
--     and suppresses normal bot processing for that message.
--   - the runner marks any still-pending row 'expired' when the task settles, so
--     a late reply can never be swallowed by a finished task.
--
-- Concurrency is naturally 1 (the runner processes one code task at a time), so
-- at most one row is 'pending' for a given thread at any moment.

CREATE TABLE IF NOT EXISTS code_task_questions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          UUID REFERENCES agent_messages(id),
  slack_channel    TEXT NOT NULL,
  slack_thread_ts  TEXT NOT NULL,
  question         TEXT NOT NULL,
  answer           TEXT,
  asked_by         TEXT NOT NULL DEFAULT 'claude',
  answered_by      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | answered | expired
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at      TIMESTAMPTZ
);

-- The webhook looks up the pending question for a thread; the CLI polls by id.
-- Partial index keeps the hot "is there a pending question in this thread?"
-- lookup tiny (only unanswered rows are indexed).
CREATE INDEX IF NOT EXISTS idx_code_task_questions_pending
  ON code_task_questions (slack_thread_ts)
  WHERE status = 'pending';

-- Lookup of a task's questions (runner expiry sweep on settle).
CREATE INDEX IF NOT EXISTS idx_code_task_questions_task
  ON code_task_questions (task_id);
