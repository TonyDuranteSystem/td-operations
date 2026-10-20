-- Client invoicing: remember whether an invoice email actually reached the customer (Resend tells us afterwards, by webhook).
-- invoice_id lets us find an invoice's emails without guessing from the subject. Everything is nullable; nothing is deleted.
ALTER TABLE email_tracking ADD COLUMN IF NOT EXISTS invoice_id uuid;
ALTER TABLE email_tracking ADD COLUMN IF NOT EXISTS delivery_status text;       -- delivered | delayed | not_delivered (set by the webhook only)
ALTER TABLE email_tracking ADD COLUMN IF NOT EXISTS delivery_detail text;       -- suppressed | bounced | failed (a short reason code)
ALTER TABLE email_tracking ADD COLUMN IF NOT EXISTS delivery_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_email_tracking_gmail_message_id ON email_tracking (gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_tracking_invoice_id ON email_tracking (invoice_id) WHERE invoice_id IS NOT NULL;

-- Link the invoice emails sent so far to their invoice (the subject is "Invoice INV-xxxxxx from <company>"). Only fills empty links.
UPDATE email_tracking t
SET invoice_id = i.id
FROM client_invoices i
WHERE t.invoice_id IS NULL
  AND t.account_id = i.account_id
  AND t.subject LIKE 'Invoice ' || i.invoice_number || ' from %';
