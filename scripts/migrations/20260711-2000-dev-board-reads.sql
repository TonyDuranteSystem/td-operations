-- Per-user "last opened the Dev Board" marker, so the sidebar notification dot
-- can count only cards created SINCE the user last looked (and clear on visit).
CREATE TABLE IF NOT EXISTS dev_board_reads (
  user_id      uuid PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
