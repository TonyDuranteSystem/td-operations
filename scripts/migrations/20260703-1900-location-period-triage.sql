-- Location-Period Triage (Smart Categorization v2, Phase 2b — 2026-07-03).
-- Design: dual-adversarial-reviewed (senior engineer + AI architect, round 2
-- APPROVE-WITH-CONDITIONS). Staff-only v1, deterministic location inference,
-- period answers as reversible attested batches.
--
-- 1. pnl_workspace_transactions: per-row deterministic location label.
--    loc_code: ISO-3166 alpha-2 OR the exceptionally-reserved region token 'EU'
--    (multi-country merchants like Glovo — can never collide with a country).
--    CHECKs in the migration itself (engineer cond. 5; prod/sandbox CHECK-
--    divergence precedent: a green sandbox insert proves nothing without them).
-- 2. pnl_period_answers / pnl_period_answer_rows: one row per period sweep +
--    per-transaction PRIOR STATE so Undo is an exact restore, never a reset
--    (engineer blocker 1/2: linkage lives HERE, notes only carry the
--    'manual: period answer <batch_id>' immunity marker).
--    loc_codes is a SET (architect cond. 6: a country card merged with its
--    containing 'EU' period sweeps both codes as ONE batch).
--    member_id is RESERVED, unused in v1 (engineer cond. 4: future per-member
--    draw attribution without a second migration).

ALTER TABLE pnl_workspace_transactions
  ADD COLUMN IF NOT EXISTS loc_code text,
  ADD COLUMN IF NOT EXISTS loc_source text,
  ADD COLUMN IF NOT EXISTS loc_confidence text;

DO $$ BEGIN
  ALTER TABLE pnl_workspace_transactions
    ADD CONSTRAINT pnl_ws_tx_loc_code_check
    CHECK (loc_code IS NULL OR loc_code ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE pnl_workspace_transactions
    ADD CONSTRAINT pnl_ws_tx_loc_source_check
    CHECK (loc_source IS NULL OR loc_source IN ('text', 'map'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE pnl_workspace_transactions
    ADD CONSTRAINT pnl_ws_tx_loc_confidence_check
    CHECK (loc_confidence IS NULL OR loc_confidence IN ('high', 'medium'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Period-answer batches (header). undone_at set = fully reversed.
CREATE TABLE IF NOT EXISTS pnl_period_answers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES pnl_workspaces(id) ON DELETE CASCADE,
  loc_codes     text[] NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  choice        text NOT NULL CHECK (choice IN ('business', 'personal')),
  actor_id      text NOT NULL,
  actor_role    text NOT NULL CHECK (actor_role IN ('staff', 'client')),
  member_id     uuid,           -- reserved for per-member attribution (unused v1)
  row_count     integer NOT NULL DEFAULT 0,
  dollar_total  numeric NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  undone_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pnl_period_answers_workspace
  ON pnl_period_answers (workspace_id, created_at DESC);

-- Per-row prior state — the undo restore source (exact category/subcategory/
-- notes as they were the instant before the sweep, incl. ai:high@vN stamps).
CREATE TABLE IF NOT EXISTS pnl_period_answer_rows (
  batch_id         uuid NOT NULL REFERENCES pnl_period_answers(id) ON DELETE CASCADE,
  transaction_id   uuid NOT NULL REFERENCES pnl_workspace_transactions(id) ON DELETE CASCADE,
  prev_category    text,
  prev_subcategory text,
  prev_notes       text,
  PRIMARY KEY (batch_id, transaction_id)
);

ALTER TABLE pnl_period_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pnl_period_answer_rows ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE pnl_period_answers IS
  'Location-period triage: one attested bulk answer ("Were you in Italy Feb-Aug? -> all business/personal") per detected presence period. loc_codes is the swept code set (country + containing EU region merge as one batch). Undo = per-row prior-state restore from pnl_period_answer_rows, then undone_at stamped. RLS ON, no policy — service-role only.';
COMMENT ON TABLE pnl_period_answer_rows IS
  'Per-transaction prior state captured at sweep time — the Undo restore source. RLS ON, no policy — service-role only.';
COMMENT ON COLUMN pnl_workspace_transactions.loc_code IS
  'Deterministic spend location: ISO-3166 alpha-2 or region token EU. Sources: text (Chase city gazetteer) | map (frozen geo-exclusive merchant map). NULL = no presence location (online/SaaS/transfer/income or no signal).';
