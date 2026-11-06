-- Tax Return workspace, Part 2 item 4 (dev job 6f555c9f), 2026-11-06. DATA ONLY: two stage layouts and one client label of the Tax Return
-- pipeline (pipeline_stages). No schema change.
--
--  1. "Preparation": the "Upload Prepared Tax Return" box now lives HERE (it was on "Data Received", where an upload jumped the job to
--     Preparation and the step where the return is really prepared had no box; the box was used once, 2026-08-24). It is a TYPED Storage box
--     (Antonio's 2026-10-28 rule: a workspace upload follows the Storage rule): default type "Tax return" (a draft that is never shown to the
--     client), the staff can pick another return type from the list, the file goes into the company's Tax folder. The upload does NOT move the
--     job (autoAdvance false): the unsigned return stays internal and "Return ready" is its own button — which asks first, because moving
--     to "TR Completed" tells the client their return is Ready to Sign, so the document must be sent for signature before that.
--     The data viewer is added so the preparer has the client's answers on this step too.
--  2. "Data Received": the upload box is replaced by a "Start Preparation" button (-> Preparation).
--  3. "Preparation": the client's progress-bar label "With Accountant" (the accountant hand-off was retired 2026-10-18) becomes "Being prepared"
--     (Italian: "In preparazione"); the client sees the same words in the step notice.
--
-- Each UPDATE only fires while the row is EXACTLY as read from production on 2026-11-06 (idempotent; never overwrites a later edit).
-- Undo: 20261106-2300-tax-return-prepared-return-box-at-preparation.UNDO.sql. Sandbox first; production only on Antonio's word.

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Start Preparation", "target": "Preparation"}]}, {"type": "chat"}], "description": "Data received. Start preparing the tax return."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Data Received'
  AND stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_upload", "label": "Upload Prepared Tax Return"}, {"type": "document_viewer"}, {"type": "chat"}], "description": "Data received. Prepare the tax return."}'::jsonb;

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "data_viewer"}, {"type": "document_upload", "label": "Upload Prepared Tax Return", "folder": "3. Tax", "autoAdvance": false, "documentType": "tax_return", "storageHint": {"asks": "the prepared tax return (not yet signed)", "acceptsTypes": ["form_1120", "form_5472", "form_1120_5472", "form_1065", "form_1120c"], "fromStages": ["Data Received"], "effects": ["save the file on the case, in the company''s Tax folder", "keep it hidden from the client (the unsigned return is never shown)"]}}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Return ready — mark Ready to Sign", "target": "TR Completed", "confirm": "Mark this return Ready to Sign? The client will be told it is ready, so send it for signature first (Tools > E-Sign) — otherwise there is nothing for them to sign yet."}]}, {"type": "chat"}], "description": "Tax return being prepared. Upload the prepared return when it is ready."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Preparation'
  AND stage_layout = '{"components": [{"type": "document_viewer"}, {"type": "info_panel"}, {"type": "chat"}], "description": "Tax return being prepared by accountant."}'::jsonb;

UPDATE pipeline_stages
SET client_label = 'Being prepared', client_label_it = 'In preparazione'
WHERE service_type = 'Tax Return' AND stage_name = 'Preparation'
  AND client_label = 'With Accountant' AND client_label_it = 'Dal Commercialista';
