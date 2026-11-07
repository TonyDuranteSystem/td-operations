-- UNDO for 20261106-2330-tax-return-send-for-signature-steps.sql. Removes the two new steps ONLY while no job sits on them (a job on a step would be
-- stranded: move it first), puts the "Preparation" layout back to the item-4 version and gives "TR Completed" its client label back.
-- Each statement only fires on the exact new row (never overwrites a later edit).

DELETE FROM pipeline_stages
WHERE service_type = 'Tax Return' AND stage_name IN ('Sent for Signature', 'Signed')
  AND NOT EXISTS (SELECT 1 FROM service_deliveries sd WHERE sd.service_type = 'Tax Return' AND sd.stage IN ('Sent for Signature', 'Signed'));

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_upload", "label": "Upload Prepared Tax Return", "folder": "3. Tax", "autoAdvance": false, "documentType": "tax_return", "storageHint": {"asks": "the prepared tax return (not yet signed)", "acceptsTypes": ["form_1120", "form_5472", "form_1120_5472", "form_1065", "form_1120c"], "fromStages": ["Data Received"], "effects": ["save the file on the case, in the company''s Tax folder", "keep it hidden from the client (the unsigned return is never shown)"]}}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Return ready — mark Ready to Sign", "target": "TR Completed", "confirm": "Mark this return Ready to Sign? The client will be told it is ready, so send it for signature first (Tools > E-Sign) — otherwise there is nothing for them to sign yet."}]}, {"type": "chat"}], "description": "Tax return being prepared. Upload the prepared return when it is ready."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Preparation'
  AND stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_upload", "label": "Upload Prepared Tax Return", "folder": "3. Tax", "autoAdvance": false, "documentType": "tax_return", "storageHint": {"asks": "the prepared tax return (not yet signed)", "acceptsTypes": ["form_1120", "form_5472", "form_1120_5472", "form_1065", "form_1120c"], "fromStages": ["Data Received"], "effects": ["save the file on the case, in the company''s Tax folder", "keep it hidden from the client (the unsigned return is never shown)"]}}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "esign_panel", "title": "Return for the client to sign", "label": "Send the return for signature", "rename": "Tax Return {year} - {company_name}", "helpText": "Upload the prepared return above, then open the signing editor: place the signature field, check the client and press Send. The job moves to Sent for Signature when you send it, and to Signed when the client signs. Nothing is faxed or filed automatically."}, {"type": "chat"}], "description": "Tax return being prepared. Upload the prepared return when it is ready, then send it for signature."}'::jsonb;

UPDATE pipeline_stages
SET client_label = 'Ready to Sign', client_label_it = 'Pronto per la Firma'
WHERE service_type = 'Tax Return' AND stage_name = 'TR Completed'
  AND client_label IS NULL AND client_label_it IS NULL;
