-- Hermes ↔ Claude bridge — Phase 2, Slice 1: action-authorization rail (QUEUE ONLY)
-- dev_task: (Phase 2 of 1a0d1354 umbrella — Hermes interface rollout)
--
-- WHAT
-- One table (approval_queue) that records ACTIONS PROPOSED by the bridge worker
-- (or Claude Code) for Antonio to approve before anything runs. Slice 1 is the
-- safe scaffolding: the worker's new propose_action tool writes a status='pending'
-- row here and NOTHING EXECUTES. Approval + execution are later slices.
--
-- WHY
-- Phase 1 is research-only: the worker describes an implied action but can't do
-- it. Phase 2 gives those actions a durable home (this queue) so a human can
-- approve them on a portal card. Slice 1 deliberately stops at "queued" — no
-- execute path exists yet, by design. This keeps the risky half (running the
-- action) isolated to a separate, reviewable slice.
--
-- SCOPE OF THIS MIGRATION
-- - One enum (approval_status)
-- - approval_queue table with CHECKs, indexes, comments
-- - RLS enabled with NO policies → service-role-only access (supabaseAdmin)
-- - Reuses the existing agent_message_party enum for requested_by
--
-- NOT in this migration (later slices):
-- - Approve/reject transitions, claim+execute worker, portal /portal/team/approvals
-- - Telegram push, re-tier of existing write tools onto this rail

-- ─────────────────────────────────────────────────────────────────────────────
-- Enum
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM (
    'pending', 'approved', 'rejected', 'executing', 'executed', 'failed', 'expired'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_queue (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Optional grouping: a single Hermes request can fan out into several proposed
  -- actions that Antonio approves/rejects together. NULL = standalone proposal.
  batch_id           UUID,

  -- The agent_messages row this proposal originated from (research → action).
  -- NULL in Slice 1 — the worker loop doesn't thread the message id yet.
  source_message_id  UUID REFERENCES agent_messages(id) ON DELETE SET NULL,

  -- Who proposed the action. Reuses the bridge party enum.
  requested_by       agent_message_party NOT NULL DEFAULT 'worker',

  -- The action: a tool name (validated against the approvable allow-list in code)
  -- + the exact params it would run with.
  tool_name          TEXT NOT NULL CHECK (char_length(tool_name) BETWEEN 1 AND 100),
  params             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- SHA-256 of JSON.stringify(params) — lets the UI/executor detect drift between
  -- what was approved and what would run.
  params_hash        TEXT NOT NULL CHECK (char_length(params_hash) BETWEEN 1 AND 128),

  -- Why the worker proposes this — surfaced to Antonio on the approval card.
  rationale          TEXT CHECK (rationale IS NULL OR char_length(rationale) <= 10000),

  status             approval_status NOT NULL DEFAULT 'pending',

  -- Decision metadata (set when approved/rejected — later slices).
  decided_by         TEXT CHECK (decided_by IS NULL OR char_length(decided_by) <= 100),
  decided_at         TIMESTAMPTZ,

  -- Execution claim + outcome (set by the executor worker — later slices).
  claimed_at         TIMESTAMPTZ,
  claimed_by         TEXT CHECK (claimed_by IS NULL OR char_length(claimed_by) <= 100),
  executed_at        TIMESTAMPTZ,
  result             JSONB,
  error_text         TEXT CHECK (error_text IS NULL OR char_length(error_text) <= 10000),

  -- Optional dedup key for retried proposals.
  idempotency_key    TEXT CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),

  -- Auto-expiry so stale, un-acted proposals don't linger as actionable.
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup key uniqueness — partial so multiple NULLs are allowed (standard pattern,
-- mirrors agent_messages.idempotency_key).
CREATE UNIQUE INDEX IF NOT EXISTS approval_queue_idempotency_key_uniq
  ON approval_queue (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Hot path: "give me the oldest pending proposals".
CREATE INDEX IF NOT EXISTS idx_approval_queue_pending_created
  ON approval_queue (created_at)
  WHERE status = 'pending';

-- Filter by status (any status), newest first.
CREATE INDEX IF NOT EXISTS idx_approval_queue_status
  ON approval_queue (status, created_at DESC);

-- Expiry sweeper: find pending rows past their expires_at.
CREATE INDEX IF NOT EXISTS idx_approval_queue_expires_pending
  ON approval_queue (expires_at)
  WHERE status = 'pending';

-- "Which proposals came from this research message?"
CREATE INDEX IF NOT EXISTS idx_approval_queue_source_message
  ON approval_queue (source_message_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — deny by default. supabaseAdmin (service role) bypasses.
-- No anon / authenticated / portal access. Ever.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE approval_queue ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- Comments (self-documenting in the DB)
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE approval_queue IS
  'Hermes ↔ Claude bridge — Phase 2 action-authorization rail. Slice 1 = QUEUE ONLY (propose_action writes pending rows; nothing executes). Approve/reject + execute are later slices. Staff-only via service role.';

COMMENT ON COLUMN approval_queue.batch_id IS
  'Optional grouping for multiple proposals approved/rejected together. NULL = standalone.';
COMMENT ON COLUMN approval_queue.source_message_id IS
  'The agent_messages row this proposal came from. NULL in Slice 1 (loop does not thread it yet).';
COMMENT ON COLUMN approval_queue.requested_by IS
  'Which agent proposed: hermes | claude | worker. Default worker (the bridge worker flow).';
COMMENT ON COLUMN approval_queue.tool_name IS
  'Name of the proposed action tool. Validated against APPROVABLE_TOOL_NAMES (lib/ai-agent/approvable-tools.ts) in code.';
COMMENT ON COLUMN approval_queue.params IS
  'Exact params the action would run with — frozen at propose time.';
COMMENT ON COLUMN approval_queue.params_hash IS
  'SHA-256 of JSON.stringify(params). Lets the executor detect drift between approved and to-run params.';
COMMENT ON COLUMN approval_queue.status IS
  'pending → approved/rejected → executing → executed/failed; or expired. Slice 1 only ever writes pending.';
COMMENT ON COLUMN approval_queue.idempotency_key IS
  'Optional dedup key. A retried proposal with the same key returns the existing row (no duplicate).';
COMMENT ON COLUMN approval_queue.expires_at IS
  'Auto-expiry (default now()+24h) so stale, un-acted proposals stop being actionable.';
