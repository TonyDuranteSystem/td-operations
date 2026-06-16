-- ITIN Workspace — stage_layout for the 8 ITIN pipeline stages (service_type='ITIN').
--
-- Data migration (DML): fills stage_layout for the ITIN flow so /flows/[id]
-- renders a real staff workspace per stage. Layout is read live per render
-- (in-flight SDs are NOT pinned). Idempotent: each UPDATE sets the full layout.
--
-- Corrected design (2026-06-15): ITIN W-7/1040-NR/Schedule OI are AUTO-GENERATED
-- from the wizard — staff REVIEW (document_viewer), they don't upload at prep.
-- Forward actions use advance_next (honors the explicit target). Operational
-- addresses live in waiting_notice labels (TD office on Client Signing, IRS ITIN
-- Operation on Submitted to IRS).

UPDATE pipeline_stages SET stage_layout = '{"components": [{"type": "waiting_notice", "label": "Waiting for client to complete the ITIN wizard."}, {"type": "chat"}], "description": "Client is filling the ITIN wizard in the portal."}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'Data Collection';

UPDATE pipeline_stages SET stage_layout = '{"components": [{"type": "document_viewer"}, {"type": "info_panel"}, {"type": "chat"}], "description": "Documents auto-generated (W-7, 1040-NR, Schedule OI). Review them. Client already has them in portal."}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'Document Preparation';

UPDATE pipeline_stages SET stage_layout = '{"components": [{"type": "waiting_notice", "label": "Mail to: Tony Durante LLC, 11125 Park Blvd Suite 104-153, Seminole, Florida 33772"}, {"type": "document_viewer"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Documents Received at Office", "target": "Documents Received"}]}], "description": "Client must print, sign with wet ink, and mail to TD office. Click below when package arrives."}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'Client Signing';

UPDATE pipeline_stages SET stage_layout = '{"components": [{"type": "document_upload", "label": "Upload received package scan"}, {"type": "document_viewer"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Package Complete — Send to CAA Review", "target": "CAA Review"}]}], "description": "Verify: 2x signed W-7, 2x signed 1040-NR + Schedule OI, 2x color passport copies."}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'Documents Received';

UPDATE pipeline_stages SET stage_layout = '{"components": [{"type": "document_viewer"}, {"type": "info_panel"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Ready to Submit to IRS", "target": "Submitted to IRS"}]}], "description": "Antonio: certify passport copies, prepare COA, assemble IRS package."}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'CAA Review';

UPDATE pipeline_stages SET stage_layout = '{"components": [{"type": "document_upload", "label": "Upload mailing receipt/tracking"}, {"type": "waiting_notice", "label": "IRS ITIN Operation, PO Box 149342, Austin TX 78714-9342"}, {"type": "fax_irs"}, {"type": "document_viewer"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Submitted — Wait for IRS", "target": "IRS Processing"}]}], "description": "Mail or fax the ITIN package to IRS. Upload tracking receipt."}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'Submitted to IRS';

UPDATE pipeline_stages SET stage_layout = '{"components": [{"type": "waiting_notice", "label": "IRS processing takes 7-11 weeks. Month 2: check tracking. Month 3: call IRS CAA line."}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "ITIN Received", "target": "ITIN Approved"}]}], "description": "Waiting for IRS to process the ITIN application."}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'IRS Processing';

UPDATE pipeline_stages SET stage_layout = '{"components": [{"type": "document_upload", "label": "Upload CP565 ITIN Letter"}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "chat"}], "description": "ITIN approved! Upload the CP565 letter. ITIN number will be saved to the contact."}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'ITIN Approved';
