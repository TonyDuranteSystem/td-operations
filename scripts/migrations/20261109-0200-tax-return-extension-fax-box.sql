-- Tax Return workspace, Part 2 item 7 (dev job 6f555c9f), 2026-11-09 — FILE THE EXTENSION FROM THE WORKSPACE (single-member LLCs).
-- DATA ONLY: one layout change on the "1st Installment Paid" step. No schema change.
--
--  "1st Installment Paid": the plain "Upload Extension Receipt" box (document_upload: untyped, hidden from the client, and it MOVED the job to
--  "Extension Filed" by itself on upload) is replaced by the extension box (extension_fax_panel): review + generate the official Form 7004, fax it to
--  the IRS from the workspace, and when Faxage confirms delivery the system merges the 7004 with the fax receipt, saves ONE document in the company's
--  Tax folder (type Form 7004, shown to the client), moves the job to "Extension Filed" and tells the client in the portal chat
--  (cron /api/cron/extension-fax-confirm). For companies that are not single-member LLCs the box shows the SAME plain upload box as before (the label
--  is carried over), so nothing changes for them until it is decided.
--
-- ORDER OF SHIPPING: the CODE first (it knows the new component type), THEN this change. Applied before the code, the step would show an
-- "Unknown component type" box. The UPDATE only fires while the row is EXACTLY as the earlier migrations left it (idempotent; never overwrites a
-- later edit).
-- Undo: 20261109-0200-tax-return-extension-fax-box.UNDO.sql. Sandbox first; production only on Antonio's word.

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "info_panel"}, {"type": "extension_fax_panel", "label": "Upload Extension Receipt"}, {"type": "chat"}], "description": "1st installment paid. File the extension from here: generate the Form 7004, fax it to the IRS. The job moves to Extension Filed by itself once the fax is delivered."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = '1st Installment Paid'
  AND stage_layout = '{"components": [{"type": "info_panel"}, {"type": "document_upload", "label": "Upload Extension Receipt"}, {"type": "chat"}], "description": "1st installment paid. File the extension and upload the receipt."}'::jsonb;
