-- S2 (AI place field): allow 'ai' as a location source on workspace rows.
-- Deterministic sources ('text' = tokens in the description, 'map' = the frozen
-- merchant map) keep precedence in code — an 'ai' label is advisory (medium
-- confidence, never creates presence periods, never overwrites deterministic).
-- Idempotent: drop + re-add the CHECK.

ALTER TABLE pnl_workspace_transactions
  DROP CONSTRAINT IF EXISTS pnl_ws_tx_loc_source_check;

ALTER TABLE pnl_workspace_transactions
  ADD CONSTRAINT pnl_ws_tx_loc_source_check
  CHECK (loc_source IS NULL OR loc_source = ANY (ARRAY['text'::text, 'map'::text, 'ai'::text]));
