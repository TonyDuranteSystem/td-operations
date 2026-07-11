-- Point-of-work issues: a cheap per-client cache of the client-diagnostic result
-- so the Portal Chats list can show a ⚠️ + count + filter WITHOUT running the full
-- diagnostic on every row. Refreshed in the background (daily cron) and on demand
-- when a client's Issues tab is opened. The full diagnostic + one-click fixes still
-- run live in the tab; this table only feeds the list indicators.
CREATE TABLE IF NOT EXISTS client_issue_counts (
  account_id   uuid PRIMARY KEY,
  error_count   integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  checked_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE client_issue_counts IS 'Cached per-account count of client-diagnostic errors/warnings, feeding the Portal Chats issue indicators (⚠️/count/filter). Source of truth is the live diagnostic; this is a refreshable cache.';
