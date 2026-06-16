-- ITIN Workspace — stage_layout for the 8 ITIN pipeline stages (service_type='ITIN').
--
-- Data migration (DML): the stage_layout column already exists; this fills it for
-- the ITIN flow so /flows/[id] renders a real staff workspace per stage. Layout is
-- read live per render (in-flight SDs are NOT pinned), so this takes effect for all
-- ITIN flows immediately. Idempotent: each UPDATE sets the full layout.
--
-- document_upload uses autoAdvance:false on every ITIN stage so progression is
-- driven by the explicit advance_next buttons (avoids a stray upload jumping the
-- stage). The two operational addresses live in waiting_notice labels:
--   Client Signing  → TD mailing address (where the client sends signed originals)
--   Submitted to IRS → IRS ITIN Operation address (where staff mailed the package)

UPDATE pipeline_stages SET stage_layout = '{
  "components": [
    { "type": "info_panel" },
    { "type": "document_upload", "label": "Upload Collected Documents", "autoAdvance": false },
    { "type": "document_viewer" },
    { "type": "chat" },
    { "type": "action_buttons", "actions": [ { "key": "advance_next", "label": "Begin Document Preparation", "target": "Document Preparation" } ] }
  ],
  "description": "Collect the client''s identity documents and W-7 information."
}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'Data Collection';

-- Document Preparation: the W-7 / 1040-NR / Schedule OI are AUTO-GENERATED from
-- the wizard data — staff REVIEW them (document_viewer), they do not upload. The
-- Approve button uses advance_next (NOT the bare `approve` key, which hardcodes a
-- Tax-Return "Review Completed" target that isn't an ITIN stage).
UPDATE pipeline_stages SET stage_layout = '{
  "components": [
    { "type": "document_viewer" },
    { "type": "action_buttons", "actions": [ { "key": "advance_next", "label": "Approve Documents", "target": "Client Signing" } ] },
    { "type": "chat" }
  ],
  "description": "Review the auto-generated W-7, 1040-NR, and Schedule OI. Approve to send the client for signing."
}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'Document Preparation';

UPDATE pipeline_stages SET stage_layout = '{
  "components": [
    { "type": "info_panel" },
    { "type": "waiting_notice", "label": "Client mails the signed original documents to: Tony Durante LLC, 11125 Park Blvd Suite 104-153, Seminole, FL 33772" },
    { "type": "document_viewer" },
    { "type": "chat" },
    { "type": "action_buttons", "actions": [ { "key": "advance_next", "label": "Mark Documents Received", "target": "Documents Received" } ] }
  ],
  "description": "Waiting for the client to sign and mail the original documents."
}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'Client Signing';

UPDATE pipeline_stages SET stage_layout = '{
  "components": [
    { "type": "info_panel" },
    { "type": "document_upload", "label": "Upload Received Originals", "autoAdvance": false },
    { "type": "document_viewer" },
    { "type": "chat" },
    { "type": "action_buttons", "actions": [ { "key": "advance_next", "label": "Start CAA Review", "target": "CAA Review" } ] }
  ],
  "description": "The client''s signed originals have arrived — log them here."
}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'Documents Received';

UPDATE pipeline_stages SET stage_layout = '{
  "components": [
    { "type": "info_panel" },
    { "type": "document_viewer" },
    { "type": "chat" },
    { "type": "action_buttons", "actions": [ { "key": "advance_next", "label": "Approve — Submit to IRS", "target": "Submitted to IRS" } ] }
  ],
  "description": "Certifying Acceptance Agent review of the W-7 package."
}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'CAA Review';

UPDATE pipeline_stages SET stage_layout = '{
  "components": [
    { "type": "info_panel" },
    { "type": "waiting_notice", "label": "Package mailed to the IRS ITIN Operation: PO Box 149342, Austin, TX 78714-9342" },
    { "type": "document_viewer" },
    { "type": "chat" },
    { "type": "action_buttons", "actions": [ { "key": "advance_next", "label": "Mark as IRS Processing", "target": "IRS Processing" } ] }
  ],
  "description": "W-7 package submitted to the IRS."
}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'Submitted to IRS';

UPDATE pipeline_stages SET stage_layout = '{
  "components": [
    { "type": "info_panel" },
    { "type": "waiting_notice", "label": "Awaiting IRS processing — typically 7 to 11 weeks for an ITIN to be assigned." },
    { "type": "chat" },
    { "type": "action_buttons", "actions": [ { "key": "advance_next", "label": "Record ITIN Approved", "target": "ITIN Approved" } ] }
  ],
  "description": "The IRS is processing the application."
}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'IRS Processing';

UPDATE pipeline_stages SET stage_layout = '{
  "components": [
    { "type": "info_panel" },
    { "type": "document_upload", "label": "Upload ITIN Assignment Letter", "autoAdvance": false },
    { "type": "document_viewer" },
    { "type": "chat" }
  ],
  "description": "ITIN assigned. Upload the IRS assignment letter for the client."
}'::jsonb WHERE service_type = 'ITIN' AND stage_name = 'ITIN Approved';
