-- Hermes ↔ Claude bridge — Phase 1: discussion/research rail
-- dev_task: 1a0d1354 (parent umbrella: 1717570c — Hermes interface rollout, Phase 5)
--
-- WHAT
-- One table (agent_messages) that holds inter-agent messages between Hermes
-- (Telegram, mobile) and Claude (worker + Claude Code). Hermes drops research
-- requests; a cron worker (/api/cron/hermes-bridge) invokes claude-sonnet-4-6
-- read-only via lib/ai-agent/providers.callAgent and writes findings to the
-- same row's reply column. Hermes then reads the reply and reports to Antonio
-- on Telegram in plain English. No actions, no mutations, no sends —
-- approval/execution rail is a separate Phase 2 (approval_queue + portal).
--
-- WHY (architectural decision after multi-round design)
-- Eliminates Antonio's "human relay" role. Today he copies questions from
-- Telegram into Claude Code and copies findings back. The worker fires every
-- 5 min so nothing is gated on Antonio being at a laptop.
--
-- SCOPE OF THIS MIGRATION
-- - Two enums (party, status)
-- - agent_messages table with CHECKs, indexes, comments
-- - RLS enabled with NO policies → service-role-only access (supabaseAdmin),
--   no anon/authenticated/portal/client access
--
-- NOT in this migration (Phase 2/3, separate tasks):
-- - approval_queue table
-- - Portal admin page
-- - Re-tier of existing write tools (gmail_send etc.)

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE agent_message_party AS ENUM ('hermes', 'claude', 'worker');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agent_message_status AS ENUM ('pending', 'processing', 'done', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  sender          agent_message_party NOT NULL,
  recipient       agent_message_party NOT NULL,

  subject         TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 500),
  body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 50000),

  status          agent_message_status NOT NULL DEFAULT 'pending',

  reply           TEXT CHECK (reply IS NULL OR char_length(reply) <= 200000),
  replied_at      TIMESTAMPTZ,

  claimed_at      TIMESTAMPTZ,
  claimed_by      TEXT CHECK (claimed_by IS NULL OR char_length(claimed_by) <= 100),

  context_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT  CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),
  error_text      TEXT  CHECK (error_text IS NULL OR char_length(error_text) <= 10000),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Can't talk to yourself.
  CONSTRAINT agent_messages_sender_neq_recipient CHECK (sender <> recipient)
);

-- Optional dedup key for retried sends. NULLs are allowed and not unique-coerced
-- (Postgres' standard UNIQUE-with-NULL semantics).
CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_idempotency_key_uniq
  ON agent_messages (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Worker hot path: "give me the oldest pending messages for recipient X".
CREATE INDEX IF NOT EXISTS idx_agent_messages_pending_by_recipient
  ON agent_messages (recipient, created_at)
  WHERE status = 'pending';

-- Inbox view: "show me what's addressed to me, by status, newest first".
CREATE INDEX IF NOT EXISTS idx_agent_messages_recipient_status_created
  ON agent_messages (recipient, status, created_at DESC);

-- "What did I send and what came back?"
CREATE INDEX IF NOT EXISTS idx_agent_messages_sender_created
  ON agent_messages (sender, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — deny by default. supabaseAdmin (service role) bypasses.
-- No anon / authenticated / portal access. Ever.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- Comments (self-documenting in the DB)
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE agent_messages IS
  'Hermes ↔ Claude bridge — discussion/research rail. Phase 1 of dev_task 1a0d1354. Authorization rail is a separate Phase 2 approval_queue. Staff-only via service role.';

COMMENT ON COLUMN agent_messages.sender IS
  'Which agent created this row: hermes | claude | worker.';
COMMENT ON COLUMN agent_messages.recipient IS
  'Which agent should respond: hermes | claude | worker.';
COMMENT ON COLUMN agent_messages.status IS
  'pending → processing (claimed by worker / Claude session) → done | failed | cancelled.';
COMMENT ON COLUMN agent_messages.reply IS
  'Findings/answer written by the responder. Reply is on the SAME row, not a new row — discussion is single-turn for MVP.';
COMMENT ON COLUMN agent_messages.claimed_by IS
  'Identifier of the process that took this message (e.g. "cron-worker", "claude-code:session_id").';
COMMENT ON COLUMN agent_messages.idempotency_key IS
  'Optional dedup key. Hermes may pass an idempotency_key on retry; UNIQUE index makes duplicates a violation. NULL means no dedup.';
COMMENT ON COLUMN agent_messages.context_json IS
  'Optional structured context — account_id, contact_id, related dev_task_id, related URLs. Not used for routing in Phase 1.';
COMMENT ON COLUMN agent_messages.error_text IS
  'Populated when status=failed (Anthropic API error, tool loop bust, etc.). Helps debugging.';
