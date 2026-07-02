-- P&L workspace tool: explicit "Generate P&L" stage (Antonio, 2026-07-02).
-- A workspace now opens in UPLOAD mode — staff upload all statements first and
-- press Generate; the P&L is only rendered after generated_at is stamped.
-- NULL = still in the upload stage (also the state of every pre-existing
-- workspace, which therefore shows the upload manager once on next open — a
-- deliberate one-time nudge to re-check the file list before regenerating).

ALTER TABLE pnl_workspaces ADD COLUMN IF NOT EXISTS generated_at timestamptz;

COMMENT ON COLUMN pnl_workspaces.generated_at IS
  'When staff last pressed Generate P&L. NULL = upload stage (no totals shown). Compared against the latest ingested transaction to flag stale generations.';
