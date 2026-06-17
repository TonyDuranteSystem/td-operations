-- cron_email_state — durable per-cron "last emailed" snapshot, so noisy crons
-- only email when something actually changed (and at most once / 24h).
--
-- key             = cron identifier (e.g. 'audit-health-check')
-- snapshot        = the set of findings last communicated, as { key: {severity,count} }
-- last_emailed_at = when the last alert email actually went out (drives the 24h throttle)
--
-- First consumer: /api/cron/audit-health-check. Reusable by any future cron that
-- wants change-detected, throttled email alerts.

CREATE TABLE IF NOT EXISTS cron_email_state (
  key             text PRIMARY KEY,
  snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_emailed_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
