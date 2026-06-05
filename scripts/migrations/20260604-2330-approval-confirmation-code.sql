-- Hermes ↔ Claude bridge — WP1: approval confirmation code
-- dev_task: (Phase 2 of 1a0d1354 umbrella — Hermes Operating Agent wiring, WP1)
--
-- WHAT
-- Adds a single nullable column, approval_queue.confirmation_code, holding a
-- 6-digit code minted at propose time. Antonio must type this exact code to
-- approve a proposal (approval_decide(approve) verifies it), so an approval can't
-- happen by accident, by a wrong-id typo, or by approving the wrong proposal.
--
-- WHY
-- WP1 wires the approval rail toward an Operating-Agent (Hermes) pull model where
-- an external instance claims and executes approved actions. A typed
-- confirmation code is the human-in-the-loop safety: it binds Antonio's "approve"
-- to one specific, visible proposal — the same discipline as gmail_send /
-- agent_msg_send, but mechanically enforced rather than only documented.
--
-- SCOPE OF THIS MIGRATION
-- - approval_queue += confirmation_code TEXT (nullable, additive, idempotent)
--
-- NOTE
-- Nullable on purpose: pre-WP1 rows have no code and therefore cannot be approved
-- (fail-closed). Every new proposal gets a code from proposeAction. No backfill —
-- old rows are stale test rows; they should expire, not be approved.

ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS confirmation_code TEXT;

COMMENT ON COLUMN approval_queue.confirmation_code IS
  '6-digit code minted at propose time (WP1). approval_decide(approve) requires a matching code. NULL on pre-WP1 rows → those cannot be approved (fail-closed).';
