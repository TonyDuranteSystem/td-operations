-- Invoice reminder history log.
-- Records every payment reminder actually sent (auto by the dunning cron OR
-- manual from the dashboard), so the UI can show per-invoice reminder history
-- and distinguish automatic vs manual chasing. dev_task d2af38a1 (Phase 2).
--
-- payments.reminder_count / last_reminder_at remain the fast denormalized
-- counters; this table is the detailed audit/source breakdown.

CREATE TABLE IF NOT EXISTS invoice_reminder_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  account_id      uuid REFERENCES accounts(id) ON DELETE SET NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL CHECK (source IN ('auto','manual')),
  reminder_number integer,
  recipient_email text,
  language        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_reminder_log_payment
  ON invoice_reminder_log (payment_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_reminder_log_account
  ON invoice_reminder_log (account_id, sent_at DESC);
