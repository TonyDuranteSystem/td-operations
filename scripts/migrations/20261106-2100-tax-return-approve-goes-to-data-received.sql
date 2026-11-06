-- Tax Return workspace buttons — Part 2 of the Tax Return plan (dev job 6f555c9f), 2026-11-06. DATA ONLY: three stage layouts and one client label of the
-- Tax Return pipeline (pipeline_stages). No schema change.
--
--  1. "Under Review": the Approve button now goes straight to "Data Received". The client's own "Confirm" step was removed
--     (Antonio, 2026-11-06 — not one client ever pressed it), so there is no "Approved" -> "Confirmed" detour any more.
--  2. "TR Completed": the File with IRS button now ASKS first ("Mark this return as filed with the IRS? ...") — it moves the job to
--     "TR Filed", which closes the work and removes the client's tax banner, so it must not be a stray click.
--  3. "Approved": the staff button "Confirm" (-> "Confirmed") is replaced by "Continue to Data Received". Nothing sits at "Approved"
--     any more (verified on production 2026-11-06: no Tax Return job at 48/49), this only keeps a stray one from being stranded.
--
--  4. "Confirmed": its client label is cleared, so the client's progress bar no longer shows a step the client never takes (and the
--     bar's marker, which sat on "Confirmed" after an approval, now sits on "Approved"). The stage row stays; only the label goes.
--
-- Each UPDATE only fires while the layout is still EXACTLY the one read from production on 2026-11-06 (idempotent, and it never
-- overwrites a layout someone edited since). Undo: 20261106-2100-tax-return-approve-goes-to-data-received.UNDO.sql
-- Sandbox first (node scripts/apply-migration.js <file>); production only on Antonio's word.

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "approve", "label": "Approve", "target": "Data Received"}, {"key": "request_changes", "label": "Request Changes", "target": "Revision Requested"}]}], "description": "Reviewing submitted tax data."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Under Review'
  AND stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "approve", "label": "Approve", "target": "Approved"}, {"key": "request_changes", "label": "Request Changes", "target": "Revision Requested"}]}], "description": "Reviewing submitted tax data."}'::jsonb;

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "file_with_irs", "label": "File with IRS", "target": "TR Filed", "confirm": "Mark this return as filed with the IRS? The client will see it as Filed and their tax banner will go away."}]}, {"type": "fax_irs"}, {"type": "chat"}], "description": "Tax return completed. Ready to sign and file."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'TR Completed'
  AND stage_layout = '{"components": [{"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "file_with_irs", "label": "File with IRS", "target": "TR Filed"}]}, {"type": "fax_irs"}, {"type": "chat"}], "description": "Tax return completed. Ready to sign and file."}'::jsonb;

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Continue to Data Received", "target": "Data Received"}]}, {"type": "chat"}], "description": "Data approved by staff."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Approved'
  AND stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Confirm", "target": "Confirmed"}]}, {"type": "chat"}], "description": "Data approved by staff."}'::jsonb;

UPDATE pipeline_stages
SET client_label = NULL, client_label_it = NULL
WHERE service_type = 'Tax Return' AND stage_name = 'Confirmed'
  AND client_label = 'Confirmed' AND client_label_it = 'Confermato';
