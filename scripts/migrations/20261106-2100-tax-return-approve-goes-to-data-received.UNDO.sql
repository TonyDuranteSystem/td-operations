-- UNDO for 20261106-2100-tax-return-approve-goes-to-data-received.sql — puts the three Tax Return stage layouts and the "Confirmed" client label back as they were.
-- Only fires while the layout is still the NEW one (never overwrites a later edit).

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "approve", "label": "Approve", "target": "Approved"}, {"key": "request_changes", "label": "Request Changes", "target": "Revision Requested"}]}], "description": "Reviewing submitted tax data."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Under Review'
  AND stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "approve", "label": "Approve", "target": "Data Received"}, {"key": "request_changes", "label": "Request Changes", "target": "Revision Requested"}]}], "description": "Reviewing submitted tax data."}'::jsonb;

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "file_with_irs", "label": "File with IRS", "target": "TR Filed"}]}, {"type": "fax_irs"}, {"type": "chat"}], "description": "Tax return completed. Ready to sign and file."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'TR Completed'
  AND stage_layout = '{"components": [{"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "file_with_irs", "label": "File with IRS", "target": "TR Filed", "confirm": "Mark this return as filed with the IRS? The client will see it as Filed and their tax banner will go away."}]}, {"type": "fax_irs"}, {"type": "chat"}], "description": "Tax return completed. Ready to sign and file."}'::jsonb;

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Confirm", "target": "Confirmed"}]}, {"type": "chat"}], "description": "Data approved by staff."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Approved'
  AND stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Continue to Data Received", "target": "Data Received"}]}, {"type": "chat"}], "description": "Data approved by staff."}'::jsonb;

UPDATE pipeline_stages
SET client_label = 'Confirmed', client_label_it = 'Confermato'
WHERE service_type = 'Tax Return' AND stage_name = 'Confirmed'
  AND client_label IS NULL AND client_label_it IS NULL;
