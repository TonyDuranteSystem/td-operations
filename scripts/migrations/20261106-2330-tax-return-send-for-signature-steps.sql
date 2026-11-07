-- Tax Return workspace, Part 2 item 5 (dev job 6f555c9f), 2026-11-06 — send the prepared return for signature FROM THE WORKSPACE.
-- DATA ONLY: two new steps of the Tax Return pipeline, one layout, one client label. No schema change.
--
--  1. NEW step "Sent for Signature" (stage_order 65): the document is out with the client. The job moves here BY ITSELF when staff press Send in the
--     e-sign editor opened from the workspace panel (no second client message — the e-sign invite is the one). Client label "Ready to Sign"
--     (Italian "Pronto per la Firma"); waiting on the client. A button marks it signed for the rare return signed outside the system.
--  2. NEW step "Signed" (stage_order 68): the client signed. The job moves here BY ITSELF when the client signs. It carries the fax panel and the
--     "File with IRS" button (moved from "TR Completed"); nothing is faxed or filed automatically. Client label "Signed" ("Firmata"); waiting on us.
--  3. "Preparation": the "Return ready - mark Ready to Sign" button (item 4) is replaced by the e-sign panel "Return for the client to sign"
--     (the same panel Company Change Name uses, worded for the return). The prepared-return upload box is unchanged.
--  4. "TR Completed" (the older "return ready" step; no button leads into it any more but it stays for old jobs and manual moves): its client label
--     "Ready to Sign" moves to the new step, so the client's progress bar shows ONE "Ready to Sign". Its layout is left as it is.
--
-- The INSERTs copy the settings of the "Preparation" row (including the catalog link) and only fire while the step does not exist yet; the UPDATEs
-- only fire while the row is EXACTLY as read from production on 2026-11-06 (idempotent; never overwrite a later edit).
-- Undo: 20261106-2330-tax-return-send-for-signature-steps.UNDO.sql. Sandbox first; production only on Antonio's word. Apply BEFORE merging the code.

INSERT INTO pipeline_stages (service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, auto_advance, client_description, service_type_entry_id, notify_client_email, client_label, client_label_it, icon, color, client_visible, board_visible, stale_days, stage_layout, notify_client_chat, tracking_check_enabled, completes_service, waiting_on, requires_document_to_advance, client_task_in_list)
SELECT p.service_type, 65, 'Sent for Signature', NULL, '[]'::jsonb, '[]'::jsonb, NULL, false, false, NULL, p.service_type_entry_id, false, 'Ready to Sign', 'Pronto per la Firma', '✍️', NULL, true, true, NULL,
  '{"components": [{"type": "waiting_notice", "label": "Waiting for the client to sign the return in the portal."}, {"type": "esign_panel", "title": "Return for the client to sign", "label": "Send the return again", "rename": "Tax Return {year} - {company_name}", "helpText": "The return is with the client. If it was cancelled or has expired, send it again here - the job stays on this step. The job moves to Signed by itself when the client signs."}, {"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Signed outside the system - mark Signed", "target": "Signed", "confirm": "Mark this return as signed? Use this only if the client signed outside the system - otherwise the job moves on by itself when the client signs."}]}, {"type": "chat"}], "description": "The return is with the client for signature."}'::jsonb,
  false, false, false, 'client', false, false
FROM pipeline_stages p
WHERE p.service_type = 'Tax Return' AND p.stage_name = 'Preparation'
  AND NOT EXISTS (SELECT 1 FROM pipeline_stages x WHERE x.service_type = 'Tax Return' AND x.stage_name = 'Sent for Signature');

INSERT INTO pipeline_stages (service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, auto_advance, client_description, service_type_entry_id, notify_client_email, client_label, client_label_it, icon, color, client_visible, board_visible, stale_days, stage_layout, notify_client_chat, tracking_check_enabled, completes_service, waiting_on, requires_document_to_advance, client_task_in_list)
SELECT p.service_type, 68, 'Signed', NULL, '[]'::jsonb, '[]'::jsonb, NULL, false, false, NULL, p.service_type_entry_id, false, 'Signed', 'Firmata', '🖋️', NULL, true, true, NULL,
  '{"components": [{"type": "esign_panel", "title": "Signed return", "readOnly": true, "rename": "Tax Return {year} - {company_name}", "helpText": "The client signed. Open it to see or download the signed copy (a copy is also filed in the company storage and shown to the client)."}, {"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "file_with_irs", "label": "File with IRS", "target": "TR Filed", "confirm": "Mark this return as filed with the IRS? The client will see it as Filed and their tax banner will go away."}]}, {"type": "fax_irs"}, {"type": "chat"}], "description": "The client signed the return. Fax it to the IRS, then mark it filed."}'::jsonb,
  false, false, false, 'us', false, false
FROM pipeline_stages p
WHERE p.service_type = 'Tax Return' AND p.stage_name = 'Preparation'
  AND NOT EXISTS (SELECT 1 FROM pipeline_stages x WHERE x.service_type = 'Tax Return' AND x.stage_name = 'Signed');

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_upload", "label": "Upload Prepared Tax Return", "folder": "3. Tax", "autoAdvance": false, "documentType": "tax_return", "storageHint": {"asks": "the prepared tax return (not yet signed)", "acceptsTypes": ["form_1120", "form_5472", "form_1120_5472", "form_1065", "form_1120c"], "fromStages": ["Data Received"], "effects": ["save the file on the case, in the company''s Tax folder", "keep it hidden from the client (the unsigned return is never shown)"]}}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "esign_panel", "title": "Return for the client to sign", "label": "Send the return for signature", "rename": "Tax Return {year} - {company_name}", "helpText": "Upload the prepared return above, then open the signing editor: place the signature field, check the client and press Send. The job moves to Sent for Signature when you send it, and to Signed when the client signs. Nothing is faxed or filed automatically."}, {"type": "chat"}], "description": "Tax return being prepared. Upload the prepared return when it is ready, then send it for signature."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Preparation'
  AND stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_upload", "label": "Upload Prepared Tax Return", "folder": "3. Tax", "autoAdvance": false, "documentType": "tax_return", "storageHint": {"asks": "the prepared tax return (not yet signed)", "acceptsTypes": ["form_1120", "form_5472", "form_1120_5472", "form_1065", "form_1120c"], "fromStages": ["Data Received"], "effects": ["save the file on the case, in the company''s Tax folder", "keep it hidden from the client (the unsigned return is never shown)"]}}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Return ready — mark Ready to Sign", "target": "TR Completed", "confirm": "Mark this return Ready to Sign? The client will be told it is ready, so send it for signature first (Tools > E-Sign) — otherwise there is nothing for them to sign yet."}]}, {"type": "chat"}], "description": "Tax return being prepared. Upload the prepared return when it is ready."}'::jsonb;

UPDATE pipeline_stages
SET client_label = NULL, client_label_it = NULL
WHERE service_type = 'Tax Return' AND stage_name = 'TR Completed'
  AND client_label = 'Ready to Sign' AND client_label_it = 'Pronto per la Firma';
