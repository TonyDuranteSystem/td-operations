-- S4 — Country-policy auto-sweep + policy persistence to the client
-- (Smart Categorization v2, 2026-07-06). Dual-adversarial-reviewed plan,
-- approved by Antonio 2026-07-06.
--
-- 1. account_location_policies: the client's STANDING country answers
--    ("everything in Spain is business"), promoted from a workspace's active
--    full-year country answers on Save-to-client. One row per account+country;
--    `active=false` = revoked (undo of an auto-swept batch revokes its source —
--    reviewer condition closing the re-sweep loop). Year-agnostic: next year's
--    workspace replays these with zero taps.
-- 2. pnl_period_answers gains:
--    - actor_role 'system' (auto-sweep batches — rendered as "Booked
--      automatically under the standing policy", exact undo unchanged);
--    - policy_revoked_at: a WORKSPACE-level full-year answer stops acting as a
--      policy without falsifying its history (undone_at means "rows restored";
--      revoked means "rows stay booked, but stop replaying this answer");
--    - source_policy_batch_id / source_account_policy_id: which policy an
--      auto-swept batch replayed — the undo route deactivates exactly that.

CREATE TABLE IF NOT EXISTS account_location_policies (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  loc_code                text NOT NULL CHECK (loc_code ~ '^[A-Z]{2}$'),
  choice                  text NOT NULL CHECK (choice IN ('business', 'personal')),
  active                  boolean NOT NULL DEFAULT true,
  promoted_from_workspace uuid,
  promoted_batch_id       uuid,
  created_by              text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, loc_code)
);

CREATE INDEX IF NOT EXISTS idx_account_location_policies_account
  ON account_location_policies (account_id) WHERE active;

ALTER TABLE account_location_policies ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE account_location_policies IS
  'Standing per-client country policies ("Spain = business, until revoked"), promoted from P&L workspace full-year country answers on Save-to-client. Replayed by the country_policy_sweep job on every workspace of this account (any tax year). active=false = revoked. RLS ON, no policy — service-role only.';

-- actor_role gains 'system' (auto-sweep batches).
ALTER TABLE pnl_period_answers
  DROP CONSTRAINT IF EXISTS pnl_period_answers_actor_role_check;
ALTER TABLE pnl_period_answers
  ADD CONSTRAINT pnl_period_answers_actor_role_check
  CHECK (actor_role IN ('staff', 'client', 'system'));

ALTER TABLE pnl_period_answers
  ADD COLUMN IF NOT EXISTS policy_revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_policy_batch_id uuid REFERENCES pnl_period_answers(id),
  ADD COLUMN IF NOT EXISTS source_account_policy_id uuid REFERENCES account_location_policies(id);

COMMENT ON COLUMN pnl_period_answers.policy_revoked_at IS
  'Set = this full-year country answer stops acting as a standing policy (auto-sweep ignores it; the country card returns). Its already-booked rows are untouched — that is what undone_at is for.';
COMMENT ON COLUMN pnl_period_answers.source_policy_batch_id IS
  'Auto-swept batches only: the workspace full-year answer this sweep replayed. Undo of the batch sets policy_revoked_at on it.';
COMMENT ON COLUMN pnl_period_answers.source_account_policy_id IS
  'Auto-swept batches only: the account standing policy this sweep replayed. Undo of the batch sets active=false on it.';
