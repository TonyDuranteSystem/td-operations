-- Company Formation workspace + 8-stage pipeline redesign.
--
-- Replaces the old 6 Company Formation pipeline stages (Data Collection, State
-- Filing, EIN Application, EIN Submitted, Post-Formation + Banking, Closing)
-- with 8 client-perspective stages, each carrying a stage_layout (drives the
-- /flows/[id] staff workspace), client_label + client_label_it (drives the
-- portal progress tracker), and — on "Articles Received" — auto_actions markers
-- that fire the compliance-date init + welcome-package enqueue (data-driven, so
-- the trigger stage is editable in SQL, never hardcoded in app code).
--
-- DML only (no DDL). Touches PROTECTED tables pipeline_stages, service_deliveries,
-- catalog_entries — apply to SANDBOX via `node scripts/apply-migration.js` (or
-- execute_sql with reason='migration:20260617-formation-workspace.sql').
-- Idempotent: re-running replaces the 8 rows and re-applies the remap (the SD
-- remap only matches OLD stage names, so a second run is a no-op for SDs).
--
-- service_type_entry_id for Company Formation = 580fbd2a-a112-4f19-9f22-dfbfc2192759
-- (the 'services' catalog entry; preserved so the service-vocabulary linkage,
-- R106, survives the row replacement).

BEGIN;

-- ── 1. Replace the pipeline stages ─────────────────────────────────────────
DELETE FROM pipeline_stages WHERE service_type = 'Company Formation';

INSERT INTO pipeline_stages
  (service_type, stage_order, stage_name, service_type_entry_id,
   client_label, client_label_it, icon, client_visible, board_visible,
   auto_advance, auto_actions, stage_layout)
VALUES
  ('Company Formation', 1, 'Payment Confirmed', '580fbd2a-a112-4f19-9f22-dfbfc2192759',
   'Payment confirmed', 'Pagamento confermato', 'CreditCard', true, true, false, NULL,
   '{"components": [{"type": "info_panel"}, {"type": "waiting_notice", "label": "Waiting for client to complete the formation wizard."}, {"type": "chat"}], "description": "Payment received. Waiting for client to submit formation details."}'::jsonb),

  ('Company Formation', 2, 'Wizard Submitted', '580fbd2a-a112-4f19-9f22-dfbfc2192759',
   'We''re reviewing your details', 'Stiamo verificando i tuoi dati', 'ClipboardCheck', true, true, false, NULL,
   '{"components": [{"type": "data_viewer"}, {"type": "info_panel"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Names Reviewed — Proceed to Name Check", "target": "Name Check"}]}], "description": "Client submitted formation data. Review LLC name choices and owner details."}'::jsonb),

  ('Company Formation', 3, 'Name Check', '580fbd2a-a112-4f19-9f22-dfbfc2192759',
   'Checking your LLC name', 'Verifica nome LLC', 'Search', true, true, false, NULL,
   '{"components": [{"type": "data_viewer"}, {"type": "external_link", "label": "Check Name Availability (NM)", "url": "https://portal.sos.state.nm.us/BFS/online/"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Name Confirmed by Client — Ready to File", "target": "Filing with State"}]}], "description": "Check LLC name availability on the Secretary of State website. Chat with client to confirm the chosen name."}'::jsonb),

  ('Company Formation', 4, 'Filing with State', '580fbd2a-a112-4f19-9f22-dfbfc2192759',
   'Filing with the state', 'Registrazione presso lo stato', 'Landmark', true, true, false, NULL,
   '{"components": [{"type": "info_panel"}, {"type": "external_link", "label": "File on Secretary of State Website", "url": "https://portal.sos.state.nm.us/BFS/online/"}, {"type": "document_upload", "label": "Upload filing confirmation/receipt"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Filed — Waiting for Articles", "target": "Articles Received"}]}], "description": "File the LLC on the Secretary of State website. Upload confirmation receipt."}'::jsonb),

  ('Company Formation', 5, 'Articles Received', '580fbd2a-a112-4f19-9f22-dfbfc2192759',
   'Articles received', 'Atto costitutivo ricevuto', 'FileCheck', true, true, false,
   '[{"type": "init_compliance_dates"}, {"type": "enqueue_welcome_package"}]'::jsonb,
   '{"components": [{"type": "document_upload", "label": "Upload Articles of Organization"}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Articles Uploaded — Prepare SS-4", "target": "SS-4 Prepared"}]}], "description": "State sent the Articles of Organization. Upload them and proceed to EIN application."}'::jsonb),

  ('Company Formation', 6, 'SS-4 Prepared', '580fbd2a-a112-4f19-9f22-dfbfc2192759',
   'Sign your SS-4', 'Firma il modulo SS-4', 'FileSignature', true, true, false, NULL,
   '{"components": [{"type": "document_viewer"}, {"type": "waiting_notice", "label": "Waiting for client to sign the SS-4 form."}, {"type": "info_panel"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Client Signed SS-4", "target": "SS-4 Signed"}]}], "description": "SS-4 form prepared. Waiting for client signature."}'::jsonb),

  ('Company Formation', 7, 'SS-4 Signed', '580fbd2a-a112-4f19-9f22-dfbfc2192759',
   'SS-4 sent to IRS', 'SS-4 inviato all''IRS', 'Send', true, true, false, NULL,
   '{"components": [{"type": "document_viewer"}, {"type": "fax_irs"}, {"type": "document_upload", "label": "Upload fax confirmation/tracking"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Faxed to IRS — Waiting for EIN", "target": "EIN Received"}]}], "description": "Client signed the SS-4. Fax to IRS and upload confirmation."}'::jsonb),

  ('Company Formation', 8, 'EIN Received', '580fbd2a-a112-4f19-9f22-dfbfc2192759',
   'EIN received — all set!', 'EIN ricevuto — tutto fatto!', 'CheckCircle2', true, true, false, NULL,
   '{"components": [{"type": "document_upload", "label": "Upload EIN Letter (CP 575)"}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "chat"}], "description": "EIN received! Upload the CP 575 letter. Formation is complete."}'::jsonb);

-- ── 2. Remap existing service_deliveries from old stage names ───────────────
-- Data Collection → Wizard Submitted when a formation wizard was submitted for
-- the SD's contact, else Payment Confirmed (no data yet).
UPDATE service_deliveries sd
SET stage = 'Wizard Submitted', stage_order = 2, updated_at = now()
WHERE sd.service_type = 'Company Formation'
  AND sd.stage = 'Data Collection'
  AND EXISTS (
    SELECT 1 FROM wizard_progress wp
    WHERE wp.contact_id = sd.contact_id
      AND wp.wizard_type = 'formation'
      AND wp.status IN ('submitted', 'completed')
  );

UPDATE service_deliveries
SET stage = 'Payment Confirmed', stage_order = 1, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'Data Collection';

UPDATE service_deliveries
SET stage = 'Filing with State', stage_order = 4, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'State Filing';

UPDATE service_deliveries
SET stage = 'SS-4 Prepared', stage_order = 6, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'EIN Application';

UPDATE service_deliveries
SET stage = 'SS-4 Signed', stage_order = 7, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'EIN Submitted';

UPDATE service_deliveries
SET stage = 'EIN Received', stage_order = 8, updated_at = now()
WHERE service_type = 'Company Formation' AND stage IN ('Post-Formation + Banking', 'Closing');

-- ── 3. Remap the formation_progress staff task-workflow actions ─────────────
-- The Slice-9 SD-progress task card's per-action visible_when/target_stage all
-- reference the old stage names; without this they'd silently stop showing.
UPDATE catalog_entries
SET metadata = jsonb_set(metadata, '{actions}', '[
  {"icon":"ClipboardCheck","slug":"verify_data_and_name","color":"blue","confirm":{"summary":"Confirm wizard data verified and LLC name candidates reviewed, advance to Name Check?"},"handler":"chain.advance_sd_stage","primary":true,"permission":{"role_in":["admin","team"]},"label_admin":"Verify Data → Name Check","visible_when":{"sd_stage":"Wizard Submitted"},"handler_params":{"target_stage":"Name Check"},"on_success_meta":{"workflow_state":"Name Check"},"on_success_status":"In Progress"},
  {"icon":"Search","slug":"confirm_name_available","color":"blue","confirm":{"summary":"Confirm LLC name is available and approved by client, advance to Filing with State?"},"handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"label_admin":"Name Confirmed → Filing with State","visible_when":{"sd_stage":"Name Check"},"handler_params":{"target_stage":"Filing with State"},"on_success_meta":{"workflow_state":"Filing with State"},"on_success_status":"In Progress"},
  {"icon":"Building2","slug":"confirm_state_filed","color":"green","confirm":{"summary":"Confirm Articles received from the state, advance to Articles Received? (Compliance dates + welcome package fire on this stage.)"},"handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"label_admin":"Articles Received","visible_when":{"sd_stage":"Filing with State"},"handler_params":{"target_stage":"Articles Received"},"on_success_meta":{"workflow_state":"Articles Received"},"on_success_status":"In Progress"},
  {"icon":"FileSignature","slug":"mark_ss4_generated","color":"blue","confirm":{"summary":"Mark SS-4 prepared and sent to client for signature, advance to SS-4 Prepared?"},"handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"label_admin":"SS-4 Prepared → Await Signature","visible_when":{"sd_stage":"Articles Received"},"handler_params":{"target_stage":"SS-4 Prepared"},"on_success_meta":{"workflow_state":"SS-4 Prepared"},"on_success_status":"Waiting"},
  {"icon":"PenSquare","slug":"mark_ss4_signed","color":"blue","confirm":{"summary":"Confirm client signed the SS-4, advance to SS-4 Signed (then fax to IRS from the workspace)?"},"handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"label_admin":"Client Signed SS-4","visible_when":{"sd_stage":"SS-4 Prepared"},"handler_params":{"target_stage":"SS-4 Signed"},"on_success_meta":{"workflow_state":"SS-4 Signed"},"on_success_status":"In Progress"},
  {"icon":"CheckCircle2","slug":"confirm_ein_received","color":"green","confirm":{"summary":"Record EIN on the Account and advance to EIN Received?"},"handler":"formation.confirm_ein_received","permission":{"role_in":["admin","team"]},"label_admin":"EIN Received → Record","visible_when":{"sd_stage":"SS-4 Signed"},"requires_input":{"field":"ein_number","label":"EIN (XX-XXXXXXX)","required":true},"on_success_meta":{"workflow_state":"EIN Received"},"on_success_status":"In Progress"},
  {"icon":"PartyPopper","slug":"mark_complete","color":"green","confirm":{"summary":"Close the Formation SD, auto-create RA Renewal SD + Annual Report SD, send client review request?"},"handler":"sd.mark_complete","permission":{"role_in":["admin","team"]},"label_admin":"Mark Formation Complete","visible_when":{"sd_stage":"EIN Received"},"handler_params":{"spawn_next_sds":["State RA Renewal","State Annual Report"],"send_review_request":true},"on_success_meta":{"workflow_state":"Completed"},"on_success_status":"Done"},
  {"icon":"AlertCircle","slug":"needs_fix","color":"amber","handler":"task.flag_blocked","permission":{"role_in":["admin","team"]},"label_admin":"Blocked / Needs Info","requires_input":{"field":"note","label":"What is the blocker?","required":true},"on_success_meta":{"workflow_state":"Blocked"},"on_success_status":"Waiting"}
]'::jsonb)
WHERE catalog_id = 'task_workflows' AND slug = 'formation_progress';

COMMIT;
