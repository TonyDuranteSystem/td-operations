-- Hermes ↔ Claude bridge — Phase A: core schema scaffolding
-- dev_task: 1a0d1354 (Hermes interface rollout) — Phase A core
--
-- WHAT
-- Substrate for the next bridge phase. NOTHING executes from this migration —
-- it adds threading columns, an instance-health table, and a thread-summary
-- table that later slices populate.
--   1. approval_queue: + executed_by, notification_sent, env, thread_id
--   2. agent_messages: + thread_id  (link a research message into a thread)
--   3. hermes_instances: heartbeat registry for the Telegram bot instance(s),
--      read by the /api/cron/hermes-health monitor.
--   4. thread_summaries: one row per resolved thread (title, outcome, what it
--      changed) — the durable record a later phase writes on thread close.
--
-- POSTURE
-- Both new tables: RLS ENABLED with NO policies → service-role-only access
-- (supabaseAdmin). Matches agent_messages / approval_queue exactly. No anon /
-- authenticated / portal / client access, ever.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS / additive, safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. approval_queue — threading + execution provenance + env tag
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE approval_queue
  ADD COLUMN IF NOT EXISTS executed_by      TEXT,
  ADD COLUMN IF NOT EXISTS notification_sent BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS env              TEXT DEFAULT 'production',
  ADD COLUMN IF NOT EXISTS thread_id        UUID;

COMMENT ON COLUMN approval_queue.executed_by      IS 'Identity that executed the action (e.g. approval-executor); distinct from claimed_by.';
COMMENT ON COLUMN approval_queue.notification_sent IS 'Whether a push/notification was sent for this proposal (dedup guard).';
COMMENT ON COLUMN approval_queue.env              IS 'Target environment this proposal executes against. Defaults to production.';
COMMENT ON COLUMN approval_queue.thread_id        IS 'Conversation thread this proposal belongs to (FK-free link to thread_summaries.thread_id / agent_messages.thread_id).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. agent_messages — thread linkage
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS thread_id UUID;

COMMENT ON COLUMN agent_messages.thread_id IS 'Conversation thread this message belongs to (links to thread_summaries.thread_id).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. hermes_instances — bot heartbeat registry
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hermes_instances (
  instance_id    TEXT PRIMARY KEY,
  last_heartbeat TIMESTAMPTZ DEFAULT now(),
  status         TEXT DEFAULT 'online',
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE hermes_instances IS 'Heartbeat registry for Hermes bot instance(s). /api/cron/hermes-health flips stale rows to offline.';

CREATE INDEX IF NOT EXISTS idx_hermes_instances_last_heartbeat
  ON hermes_instances (last_heartbeat);

ALTER TABLE hermes_instances ENABLE ROW LEVEL SECURITY;
-- No policies → service-role-only (supabaseAdmin). Matches agent_messages.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. thread_summaries — durable record of a resolved thread
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS thread_summaries (
  thread_id          UUID PRIMARY KEY,
  thread_type        TEXT NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT now(),
  resolved_at        TIMESTAMPTZ,
  title              TEXT,
  outcome            TEXT,
  files_changed      TEXT[],
  tasks_created      UUID[],
  accounts_affected  UUID[],
  summary_text       TEXT,
  tags               TEXT[],
  prompt_version     TEXT
);

COMMENT ON TABLE thread_summaries IS 'One row per resolved Hermes/Claude thread — title, outcome, what it changed. Populated by a later phase on thread close.';

CREATE INDEX IF NOT EXISTS idx_thread_summaries_thread_type
  ON thread_summaries (thread_type);

ALTER TABLE thread_summaries ENABLE ROW LEVEL SECURITY;
-- No policies → service-role-only (supabaseAdmin). Matches agent_messages.
