DROP INDEX IF EXISTS idx_email_tracking_invoice_id;
DROP INDEX IF EXISTS idx_email_tracking_gmail_message_id;
ALTER TABLE email_tracking DROP COLUMN IF EXISTS delivery_updated_at;
ALTER TABLE email_tracking DROP COLUMN IF EXISTS delivery_detail;
ALTER TABLE email_tracking DROP COLUMN IF EXISTS delivery_status;
ALTER TABLE email_tracking DROP COLUMN IF EXISTS invoice_id;
