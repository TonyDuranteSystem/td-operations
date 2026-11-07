-- UNDO for 20261106-2300-tax-return-prepared-return-box-at-preparation.sql — puts the two Tax Return stage layouts and the "Preparation" client
-- label back as they were. Each UPDATE only fires while the row is still the NEW one (never overwrites a later edit).

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_upload", "label": "Upload Prepared Tax Return"}, {"type": "document_viewer"}, {"type": "chat"}], "description": "Data received. Prepare the tax return."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Data Received'
  AND stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Start Preparation", "target": "Preparation"}]}, {"type": "chat"}], "description": "Data received. Start preparing the tax return."}'::jsonb;

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "document_viewer"}, {"type": "info_panel"}, {"type": "chat"}], "description": "Tax return being prepared by accountant."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Preparation'
  AND stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_upload", "label": "Upload Prepared Tax Return", "folder": "3. Tax", "autoAdvance": false, "documentType": "tax_return", "storageHint": {"asks": "the prepared tax return (not yet signed)", "acceptsTypes": ["form_1120", "form_5472", "form_1120_5472", "form_1065", "form_1120c"], "fromStages": ["Data Received"], "effects": ["save the file on the case, in the company''s Tax folder", "keep it hidden from the client (the unsigned return is never shown)"]}}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Return ready — mark Ready to Sign", "target": "TR Completed", "confirm": "Mark this return Ready to Sign? The client will be told it is ready, so send it for signature first (Tools > E-Sign) — otherwise there is nothing for them to sign yet."}]}, {"type": "chat"}], "description": "Tax return being prepared. Upload the prepared return when it is ready."}'::jsonb;

UPDATE pipeline_stages
SET client_label = 'With Accountant', client_label_it = 'Dal Commercialista'
WHERE service_type = 'Tax Return' AND stage_name = 'Preparation'
  AND client_label = 'Being prepared' AND client_label_it = 'In preparazione';
