-- Company Formation workspace v2 — 7-stage client-perspective pipeline.
--
-- Supersedes the abandoned 8-stage redesign (feat/formation-progress-redesign,
-- migration 20260617-formation-workspace.sql, which carried a separate "Name
-- Check" stage). v2 MERGES the SoS name check into the working "Wizard
-- Submitted" stage and renames the filing stage to "Filed with State" (a loop
-- stage: approved → Articles, or name rejected → refile). Final 7 stages:
--   1 Payment Confirmed → 2 Wizard Submitted → 3 Filed with State
--   → 4 Articles Received → 5 SS-4 Prepared → 6 SS-4 Signed → 7 EIN Received
--
-- Each stage carries:
--   • stage_layout (jsonb)        — drives the /flows/[id] staff workspace
--   • client_label / client_label_it — drives the portal progress tracker
-- Side-effects (compliance-date init + welcome-package enqueue) are hardcoded in
-- lib/service-delivery.ts to fire on advance into "Articles Received" — NOT
-- expressed as auto_actions markers here (kept simple per the v2 spec).
--
-- ── PROMOTION ORDER (production) ───────────────────────────────────────────
-- pipeline_stages.stage_layout + client_notification_message do NOT yet exist on
-- production. Apply scripts/migrations/20260615-1700-flow-workspaces-prod-columns.sql
-- FIRST (additive, idempotent), THEN this file. Sandbox already has every column.
-- client_label / client_label_it / auto_actions / icon / client_visible /
-- board_visible / auto_advance are assumed pre-existing on production (verify
-- via information_schema before promoting).
--
-- DML only (no DDL). Touches PROTECTED tables pipeline_stages,
-- service_deliveries, catalog_entries. Apply to SANDBOX via
-- `node scripts/apply-migration.js scripts/migrations/20260617-formation-workspace-v2.sql`
-- (or execute_sql with reason='migration:20260617-formation-workspace-v2.sql').
--
-- Idempotent: re-running replaces the 7 rows and re-applies the remap. The SD
-- remap matches BOTH the old production 6 stage names (Data Collection / State
-- Filing / EIN Application / EIN Submitted / Post-Formation + Banking / Closing)
-- AND the abandoned 8 stage names (… / Name Check / Filing with State / …), so it
-- lands in-flight SDs correctly whether run against production OR the sandbox's
-- abandoned-8 state. A second run is a no-op for SDs (old names no longer match).

BEGIN;

-- ── 1. Replace the pipeline stages with the 7 v2 stages ────────────────────
DELETE FROM pipeline_stages WHERE service_type = 'Company Formation';

INSERT INTO pipeline_stages
  (service_type, stage_order, stage_name, service_type_entry_id,
   client_label, client_label_it, icon, client_visible, board_visible,
   auto_advance, stage_layout)
VALUES
  ('Company Formation', 1, 'Payment Confirmed',
   (SELECT id FROM catalog_entries WHERE catalog_id='services' AND slug='company_formation'),
   'Payment confirmed', 'Pagamento confermato', 'CreditCard', true, true, false,
   '{"description": "Payment received. Waiting for the client to complete the formation wizard.", "components": [{"type": "info_panel"}, {"type": "waiting_notice", "label": "Waiting for the client to complete the formation wizard."}, {"type": "chat"}]}'::jsonb),

  ('Company Formation', 2, 'Wizard Submitted',
   (SELECT id FROM catalog_entries WHERE catalog_id='services' AND slug='company_formation'),
   'We''re reviewing your details', 'Stiamo verificando i tuoi dati', 'ClipboardCheck', true, true, false,
   '{"description": "Name command center. Review the candidate LLC names, check each on the Secretary of State, send the available one to the client for approval, and file the accepted name — all from here. The advance unlocks once a name is filed.", "components": [{"type": "formation_names"}, {"type": "info_panel"}, {"type": "data_viewer", "label": "Client Details"}, {"type": "chat"}]}'::jsonb),

  ('Company Formation', 3, 'Filed with State',
   (SELECT id FROM catalog_entries WHERE catalog_id='services' AND slug='company_formation'),
   'Filing with the state', 'Registrazione presso lo stato', 'Landmark', true, true, false,
   '{"description": "Name filed on the Secretary of State site. Waiting for the state to confirm (~1 week). When the Articles arrive, advance. If the name was rejected, choose a new name and refile.", "components": [{"type": "info_panel"}, {"type": "external_link", "label": "File on the Secretary of State site"}, {"type": "document_upload", "label": "Upload filing receipt", "autoAdvance": false}, {"type": "formation_names"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Articles Received — Company Created", "target": "Articles Received"}, {"key": "advance_next", "label": "Name Rejected — Choose New Name", "target": "Filed with State"}]}]}'::jsonb),

  ('Company Formation', 4, 'Articles Received',
   (SELECT id FROM catalog_entries WHERE catalog_id='services' AND slug='company_formation'),
   'Articles received', 'Atto costitutivo ricevuto', 'FileCheck', true, true, false,
   '{"components": [{"type": "document_viewer"}, {"type": "info_panel"}, {"type": "activate_ra"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Prepare SS-4", "target": "SS-4 Prepared"}]}], "description": "Company created! Upload the Articles if needed, activate the Registered Agent, then prepare the SS-4."}'::jsonb),

  ('Company Formation', 5, 'SS-4 Prepared',
   (SELECT id FROM catalog_entries WHERE catalog_id='services' AND slug='company_formation'),
   'Sign your SS-4', 'Firma il modulo SS-4', 'FileSignature', true, true, false,
   '{"components": [{"type": "ss4_panel"}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "Client Signed SS-4", "target": "SS-4 Signed"}]}], "description": "SS-4 form generated. Review, send to client for signature."}'::jsonb),

  ('Company Formation', 6, 'SS-4 Signed',
   (SELECT id FROM catalog_entries WHERE catalog_id='services' AND slug='company_formation'),
   'SS-4 sent to IRS', 'SS-4 inviato all''IRS', 'Send', true, true, false,
   '{"description": "Client signed the SS-4. Fax it to the IRS and upload the confirmation. The fax does NOT auto-advance — advance manually when the EIN arrives.", "components": [{"type": "document_viewer"}, {"type": "fax_irs"}, {"type": "document_upload", "label": "Upload fax confirmation / tracking", "autoAdvance": false}, {"type": "chat"}, {"type": "action_buttons", "actions": [{"key": "advance_next", "label": "EIN Received", "target": "EIN Received"}]}]}'::jsonb),

  ('Company Formation', 7, 'EIN Received',
   (SELECT id FROM catalog_entries WHERE catalog_id='services' AND slug='company_formation'),
   'EIN received — all set!', 'EIN ricevuto — tutto fatto!', 'CheckCircle2', true, true, false,
   '{"description": "EIN received from the IRS. Enter the EIN and upload the CP 575 letter. Formation is complete — use the task card to mark complete (spawns RA Renewal + Annual Report).", "components": [{"type": "document_upload", "label": "Upload EIN Letter (CP 575)", "autoAdvance": false}, {"type": "document_viewer"}, {"type": "info_panel"}, {"type": "chat"}]}'::jsonb);

-- ── 2. Remap in-flight service_deliveries onto the new stage names ──────────
-- Handles BOTH the production old-6 names AND the abandoned-8 names. Each
-- statement filters on the OLD stage value and sets the new (stage, stage_order).

-- Old "Data Collection": → Wizard Submitted when a formation wizard was
-- submitted for the SD's contact, else Payment Confirmed (no data yet).
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

-- Old-6 renames
UPDATE service_deliveries
SET stage = 'Filed with State', stage_order = 3, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'State Filing';
UPDATE service_deliveries
SET stage = 'SS-4 Prepared', stage_order = 5, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'EIN Application';
UPDATE service_deliveries
SET stage = 'SS-4 Signed', stage_order = 6, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'EIN Submitted';
UPDATE service_deliveries
SET stage = 'EIN Received', stage_order = 7, updated_at = now()
WHERE service_type = 'Company Formation' AND stage IN ('Post-Formation + Banking', 'Closing');

-- Abandoned-8 renames: Name Check folds back into Wizard Submitted; "Filing with
-- State" → "Filed with State".
UPDATE service_deliveries
SET stage = 'Wizard Submitted', stage_order = 2, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'Name Check';
UPDATE service_deliveries
SET stage = 'Filed with State', stage_order = 3, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'Filing with State';

-- Stages whose NAME is unchanged but whose stage_order shifted between the
-- abandoned-8 ordering and the v2-7 ordering (workspace matches by name, but keep
-- stage_order coherent for advanceServiceDelivery's next-stage resolution).
UPDATE service_deliveries SET stage_order = 1, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'Payment Confirmed' AND stage_order IS DISTINCT FROM 1;
UPDATE service_deliveries SET stage_order = 2, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'Wizard Submitted' AND stage_order IS DISTINCT FROM 2;
UPDATE service_deliveries SET stage_order = 4, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'Articles Received' AND stage_order IS DISTINCT FROM 4;
UPDATE service_deliveries SET stage_order = 5, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'SS-4 Prepared' AND stage_order IS DISTINCT FROM 5;
UPDATE service_deliveries SET stage_order = 6, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'SS-4 Signed' AND stage_order IS DISTINCT FROM 6;
UPDATE service_deliveries SET stage_order = 7, updated_at = now()
WHERE service_type = 'Company Formation' AND stage = 'EIN Received' AND stage_order IS DISTINCT FROM 7;

-- ── 3. Remap the formation_progress staff task-workflow actions ────────────
-- Per-action visible_when/target_stage reference old stage names (production:
-- old-6; sandbox: abandoned-8 incl. a separate "confirm_name_available" /
-- "Name Check" action). Overwrite metadata->actions with the v2-7 set:
-- name check is merged into "verify_data_and_name" (→ Filed with State); the
-- separate name action is dropped. Workspace owns the stage-3 "Name Rejected"
-- loop, so the task card carries only the forward + defensive actions.
UPDATE catalog_entries
SET metadata = jsonb_set(metadata, '{actions}', '[
  {"icon":"ClipboardCheck","slug":"verify_data_and_name","color":"blue","confirm":{"summary":"Confirm the wizard data is verified, the LLC name candidates reviewed, and the chosen name confirmed with the client — advance to Filed with State?"},"handler":"chain.advance_sd_stage","primary":true,"permission":{"role_in":["admin","team"]},"label_admin":"Verify Data → File with State","visible_when":{"sd_stage":"Wizard Submitted"},"handler_params":{"target_stage":"Filed with State"},"on_success_meta":{"workflow_state":"Filed with State"},"on_success_status":"In Progress"},
  {"icon":"Building2","slug":"confirm_state_filed","color":"green","confirm":{"summary":"Confirm the Articles were received from the state — advance to Articles Received? (Compliance dates + welcome package fire on this stage.)"},"handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"label_admin":"Articles Received — Company Created","visible_when":{"sd_stage":"Filed with State"},"handler_params":{"target_stage":"Articles Received"},"on_success_meta":{"workflow_state":"Articles Received"},"on_success_status":"In Progress"},
  {"icon":"FileSignature","slug":"mark_ss4_generated","color":"blue","confirm":{"summary":"Mark the SS-4 prepared and sent to the client for signature — advance to SS-4 Prepared?"},"handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"label_admin":"SS-4 Prepared → Await Signature","visible_when":{"sd_stage":"Articles Received"},"handler_params":{"target_stage":"SS-4 Prepared"},"on_success_meta":{"workflow_state":"SS-4 Prepared"},"on_success_status":"Waiting"},
  {"icon":"PenSquare","slug":"mark_ss4_signed","color":"blue","confirm":{"summary":"Confirm the client signed the SS-4 — advance to SS-4 Signed (then fax to the IRS from the workspace)?"},"handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"label_admin":"Client Signed SS-4","visible_when":{"sd_stage":"SS-4 Prepared"},"handler_params":{"target_stage":"SS-4 Signed"},"on_success_meta":{"workflow_state":"SS-4 Signed"},"on_success_status":"In Progress"},
  {"icon":"CheckCircle2","slug":"confirm_ein_received","color":"green","confirm":{"summary":"Record the EIN on the Account and advance to EIN Received?"},"handler":"formation.confirm_ein_received","permission":{"role_in":["admin","team"]},"label_admin":"EIN Received → Record","visible_when":{"sd_stage":"SS-4 Signed"},"requires_input":{"field":"ein_number","label":"EIN (XX-XXXXXXX)","required":true},"on_success_meta":{"workflow_state":"EIN Received"},"on_success_status":"In Progress"},
  {"icon":"PartyPopper","slug":"mark_complete","color":"green","confirm":{"summary":"Close the Formation SD, auto-create the RA Renewal + Annual Report SDs, and send the client review request?"},"handler":"sd.mark_complete","permission":{"role_in":["admin","team"]},"label_admin":"Mark Formation Complete","visible_when":{"sd_stage":"EIN Received"},"handler_params":{"spawn_next_sds":["State RA Renewal","State Annual Report"],"send_review_request":true},"on_success_meta":{"workflow_state":"Completed"},"on_success_status":"Done"},
  {"icon":"AlertCircle","slug":"needs_fix","color":"amber","handler":"task.flag_blocked","permission":{"role_in":["admin","team"]},"label_admin":"Blocked / Needs Info","requires_input":{"field":"note","label":"What is the blocker?","required":true},"on_success_meta":{"workflow_state":"Blocked"},"on_success_status":"Waiting"}
]'::jsonb)
WHERE catalog_id = 'task_workflows' AND slug = 'formation_progress';

COMMIT;
