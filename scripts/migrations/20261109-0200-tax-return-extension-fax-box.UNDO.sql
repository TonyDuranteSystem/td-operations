-- UNDO for 20261109-0200-tax-return-extension-fax-box.sql. Puts the "1st Installment Paid" layout back to the plain "Upload Extension Receipt" box.
-- Only fires on the exact new row (never overwrites a later edit). A fax already sent from the extension box stays on record; the box only
-- disappears from the screen.

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "info_panel"}, {"type": "document_upload", "label": "Upload Extension Receipt"}, {"type": "chat"}], "description": "1st installment paid. File the extension and upload the receipt."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = '1st Installment Paid'
  AND stage_layout = '{"components": [{"type": "info_panel"}, {"type": "extension_fax_panel", "label": "Upload Extension Receipt"}, {"type": "chat"}], "description": "1st installment paid. File the extension from here: generate the Form 7004, fax it to the IRS. The job moves to Extension Filed by itself once the fax is delivered."}'::jsonb;
