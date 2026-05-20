-- Migration: Workflow Dispatch Log (Operational Visibility — Phase 1, Step 1)
-- Part of the Operational Truth Layer MVP. Step 1 covers the TWO event
-- dispatchers only (form_submission, sd_created). Chained-continuation
-- coverage is Step 1b — intentionally excluded here.
--
-- Purpose: every time the workflow dispatcher tries to start an automated
-- workflow for an event, record ONE row: what fired it, which workflow
-- matched (or why none did), and the result. Today the non-spawn outcomes
-- (no match / ambiguous / failure) only reach throwaway console output, so
-- "why didn't a task appear for this client" is currently unanswerable.
--
-- This change is OBSERVATION-ONLY:
--   - New table, nothing else reads it yet.
--   - No writes to any existing table (lineage is reconstructed FROM this
--     log via spawned_task_id; we never stamp the task).
--   - No foreign keys: an audit log must never fail to write because a
--     referenced row is missing or created in the same transaction.
--   - Row-level security ENABLED with NO public policy: invisible to the
--     anon/authenticated (browser/API) roles; only the server-side
--     service-role client (which bypasses RLS) can read/write it.
--
-- Apply to SANDBOX first:
--   node scripts/apply-migration.js scripts/migrations/20260520-0836-workflow-dispatch-log.sql
-- Promote to production only after Antonio's explicit approval.

-- ─────────────────────────────────────────────────────────────────────────
-- Table: workflow_dispatch_log
-- One row per dispatch attempt from a workflow trigger event.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_dispatch_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What kind of event invoked the dispatcher.
  -- Step 1 emits only 'form_submission' and 'sd_created'. 'chain' is reserved
  -- for Step 1b (chained continuations) — added to the CHECK now so Step 1b
  -- needs no schema change, only code.
  trigger_source        TEXT NOT NULL CHECK (trigger_source IN (
                          'form_submission', 'sd_created', 'chain'
                        )),

  -- Human-readable descriptor of the event (the submissions table name for
  -- form_submission, the service_type for sd_created). For quick scanning.
  event_descriptor      TEXT,

  -- Best-known id of the record that triggered the dispatch (submission id,
  -- service-delivery id, or parent task id for chains). TEXT, not a FK —
  -- the log must write regardless of referential state.
  event_ref             TEXT,

  -- The dispatch outcome. Mirrors DispatchReason in
  -- lib/tasks/dispatch-workflow-for-event.ts, plus 'spawned' for success.
  outcome               TEXT NOT NULL CHECK (outcome IN (
                          'spawned',
                          'no_trigger_match',
                          'ambiguous',
                          'snapshot_invalid',
                          'meta_invalid',
                          'spawn_failed',
                          'already_spawned'
                        )),

  matched_workflow_slug TEXT,            -- the workflow that matched (if any)
  candidates            JSONB,           -- competing slugs when outcome='ambiguous'
  spawned_task_id       UUID,            -- task created (or existing task on already_spawned)

  -- Client linkage — same keys every other entity carries. Used by the
  -- per-account timeline (Phase 1 Step 2). No FK, see header.
  account_id            UUID,
  contact_id            UUID,
  delivery_id           UUID,            -- service-delivery id when known

  actor                 TEXT,            -- actor string passed to the dispatcher

  -- Forward lineage for Step 1b: points back at the dispatch-log row that
  -- spawned the workflow whose continuation this row records. Unused in
  -- Step 1 (always NULL). Self-reference only; no FK so the write can never
  -- fail on a missing parent.
  chained_from_id       UUID,

  -- Outcome-specific extras: error text (meta_error / spawn_error), the
  -- form_table or service_type, etc. References/ids and messages only —
  -- never full submission payloads (avoid storing client PII here).
  details               JSONB NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE workflow_dispatch_log IS
  'Operational visibility (Phase 1). One row per workflow-dispatch attempt: what fired it, which workflow matched (or why none), and the result. Observation-only; written by the server service-role client. Step 1 = form_submission + sd_created dispatchers; chain coverage is Step 1b.';
COMMENT ON COLUMN workflow_dispatch_log.outcome IS
  'spawned | no_trigger_match | ambiguous | snapshot_invalid | meta_invalid | spawn_failed | already_spawned';
COMMENT ON COLUMN workflow_dispatch_log.spawned_task_id IS
  'The task this dispatch created. Reverse lineage: given a task, find its dispatch by querying this column. We never write back onto the task.';
COMMENT ON COLUMN workflow_dispatch_log.chained_from_id IS
  'Reserved for Step 1b (chained continuations). Always NULL in Step 1.';
COMMENT ON COLUMN workflow_dispatch_log.details IS
  'Outcome-specific references and messages only. Never store full submission payloads (PII).';

-- ─── Indexes ──────────────────────────────────────────────────────────────
-- Per-client timeline reads (Phase 1 Step 2).
CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_log_account
  ON workflow_dispatch_log (account_id, created_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_log_contact
  ON workflow_dispatch_log (contact_id, created_at DESC) WHERE contact_id IS NOT NULL;

-- Activity feed ordering.
CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_log_created
  ON workflow_dispatch_log (created_at DESC);

-- Activity feed filtering on the interesting (non-spawned) outcomes.
CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_log_outcome
  ON workflow_dispatch_log (outcome, created_at DESC);

-- Reverse lineage: given a task, find the dispatch that created it.
CREATE INDEX IF NOT EXISTS idx_workflow_dispatch_log_task
  ON workflow_dispatch_log (spawned_task_id) WHERE spawned_task_id IS NOT NULL;

-- ─── Row-level security ─────────────────────────────────────────────────
-- Enable RLS with NO policy: anon/authenticated (browser/API) roles get zero
-- access; the service-role client used by the server bypasses RLS entirely.
-- This is the "admin-only / server-only" posture for an internal log.
ALTER TABLE workflow_dispatch_log ENABLE ROW LEVEL SECURITY;
