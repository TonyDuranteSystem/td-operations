-- TD Communication — Phase 10: SLA / deadline tracking.
--
-- Adds a real deadline column to td_comm_enrollments. Until now the board read
-- metadata.deadline, a value no app code ever wrote (seed-only). deadline_at is
-- the automatic, authoritative deadline = base + package.delivery_days, set on
-- the first transition out of 'enrolled' (see lib/td-communication/sla.ts).
-- metadata.deadline remains a read-time fallback for legacy seed rows.
--
-- Backfill: every enrollment that already left 'enrolled' gets a deadline_at of
-- created_at + delivery_days, falling back to the configured default_sla_days
-- (app_settings 'td_communication_settings') and finally a literal 7 when the
-- package row is missing (e.g. 'brand-identity') or has no delivery_days.

ALTER TABLE td_comm_enrollments
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz;

UPDATE td_comm_enrollments e
SET deadline_at = e.created_at
  + (
      COALESCE(
        (SELECT p.delivery_days FROM td_comm_packages p WHERE p.slug = e.package_slug),
        (SELECT (value->>'default_sla_days')::int FROM app_settings WHERE key = 'td_communication_settings'),
        7
      ) || ' days'
    )::interval
WHERE e.status <> 'enrolled'
  AND e.deadline_at IS NULL;
