-- formation_progress → workspace-pointer + v2 action remap (fix/formation-task-sync, 2026-06-20)
--
-- Two coupled changes:
--  (1) The card becomes a read-only POINTER to the /flows/[delivery_id] workspace
--      (current stage + "Open in Workspace" link, no inline advance buttons) — the
--      workspace is the single control surface. Driven by the new
--      `workspace_pointer` snapshot flag (lib/tasks/workflow-snapshot-schema.ts).
--  (2) The action set is remapped from the dead pre-v2 vocabulary to the v2
--      7-stage pipeline (Antonio's 3 decisions, 2026-06-20):
--        • verify_data_and_name      : Wizard Submitted  → Filed with State
--        • confirm_state_filed       : Filed with State  → Articles Received
--        • confirm_articles_received : Articles Received → SS-4 Prepared   (NEW)
--        • mark_ss4_generated        : SS-4 Prepared (waiting for client sig)
--        • mark_ss4_faxed            : SS-4 Prepared     → SS-4 Signed
--        • confirm_ein_received      : SS-4 Signed → EIN Received (handler-driven)
--        • mark_complete             : EIN Received (complete + spawn renewals)   [moved]
--        • needs_fix                 : always (Blocked)
--      Removed: confirm_oa_lease (Post-Formation + Banking — gone in v2).
-- Keeping the actions POPULATED (not empty) also means the pre-deploy old code
-- renders functional v2 buttons during the prod build window instead of throwing
-- on an empty actions array; the new code renders the pointer.
--
-- The slug lives on the `slug` COLUMN (cf0cb867 rule) and whats_new_events shares
-- the slug, so the catalog update is scoped by catalog_id='task_workflows'.
-- advanceServiceDelivery (lib/service-delivery.ts §6b) keeps task_meta.sd_stage /
-- workflow_state synced on every advance.

-- 1. Catalog: pointer flag + v2 action set (the single source of the JSON).
UPDATE catalog_entries
SET metadata = metadata || jsonb_build_object(
  'workspace_pointer', true,
  'actions', '[
    {"slug":"verify_data_and_name","label_admin":"Verify Data + LLC Name → Filed with State","primary":true,"icon":"ClipboardCheck","color":"blue","handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"visible_when":{"sd_stage":"Wizard Submitted"},"handler_params":{"target_stage":"Filed with State"},"confirm":{"summary":"Confirm wizard data verified and LLC name available, advance to Filed with State?"},"on_success_meta":{"workflow_state":"Filed with State"},"on_success_status":"In Progress"},
    {"slug":"confirm_state_filed","label_admin":"Filed with State → Articles Received","icon":"Building2","color":"green","handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"visible_when":{"sd_stage":"Filed with State"},"handler_params":{"target_stage":"Articles Received"},"confirm":{"summary":"Confirm Articles filed with the Secretary of State. Advance to Articles Received?"},"on_success_meta":{"workflow_state":"Articles Received"},"on_success_status":"In Progress"},
    {"slug":"confirm_articles_received","label_admin":"Articles Received → SS-4 Prepared","icon":"FileCheck","color":"green","handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"visible_when":{"sd_stage":"Articles Received"},"handler_params":{"target_stage":"SS-4 Prepared"},"confirm":{"summary":"Confirm Articles of Organization received from the state. Advance to SS-4 Prepared?"},"on_success_meta":{"workflow_state":"SS-4 Prepared"},"on_success_status":"In Progress"},
    {"slug":"mark_ss4_generated","label_admin":"SS-4 Generated → Awaiting Client Signature","icon":"FileSignature","color":"blue","handler":"task.waiting_with_optional_message","permission":{"role_in":["admin","team"]},"visible_when":{"sd_stage":"SS-4 Prepared"},"requires_input":{"field":"client_message_en","label":"Optional note to client (EN)","optional":true},"confirm":{"summary":"Mark SS-4 generated."},"on_success_meta":{"workflow_state":"Awaiting SS-4 Signature"},"on_success_status":"Waiting"},
    {"slug":"mark_ss4_faxed","label_admin":"SS-4 Faxed to IRS → Awaiting EIN","icon":"Send","color":"blue","handler":"chain.advance_sd_stage","permission":{"role_in":["admin","team"]},"visible_when":{"sd_stage":"SS-4 Prepared"},"handler_params":{"target_stage":"SS-4 Signed"},"confirm":{"summary":"Confirm SS-4 has been faxed to the IRS, advance to SS-4 Signed?"},"on_success_meta":{"workflow_state":"Awaiting EIN from IRS"},"on_success_status":"In Progress"},
    {"slug":"confirm_ein_received","label_admin":"Record EIN Received","icon":"CheckCircle2","color":"green","handler":"formation.confirm_ein_received","permission":{"role_in":["admin","team"]},"visible_when":{"sd_stage":"SS-4 Signed"},"requires_input":{"field":"ein_number","label":"EIN (XX-XXXXXXX)","required":true},"confirm":{"summary":"Record the EIN on the Account, upload the EIN letter to the portal, advance to EIN Received?"},"on_success_meta":{"workflow_state":"EIN Received"},"on_success_status":"In Progress"},
    {"slug":"mark_complete","label_admin":"Mark Formation Complete","icon":"PartyPopper","color":"green","handler":"sd.mark_complete","permission":{"role_in":["admin","team"]},"visible_when":{"sd_stage":"EIN Received"},"handler_params":{"spawn_next_sds":["State RA Renewal","State Annual Report"],"send_review_request":true},"confirm":{"summary":"Close the Formation SD, auto-create RA Renewal + Annual Report SDs, send the client review request?"},"on_success_meta":{"workflow_state":"Completed"},"on_success_status":"Done"},
    {"slug":"needs_fix","label_admin":"Blocked / Needs Info","icon":"AlertCircle","color":"amber","handler":"task.flag_blocked","permission":{"role_in":["admin","team"]},"requires_input":{"field":"note","label":"What is the blocker?","required":true},"on_success_meta":{"workflow_state":"Blocked"},"on_success_status":"Waiting"}
  ]'::jsonb
),
    updated_at = now()
WHERE slug = 'formation_progress'
  AND catalog_id = 'task_workflows';

-- 2. In-flight task snapshots: re-pin to pointer mode + the SAME v2 action set
--    (copied from the catalog row just updated, so there is one source of truth).
UPDATE tasks t
SET workflow_snapshot = t.workflow_snapshot || jsonb_build_object(
      'workspace_pointer', true,
      'actions', (SELECT ce.metadata->'actions' FROM catalog_entries ce
                  WHERE ce.slug = 'formation_progress' AND ce.catalog_id = 'task_workflows')
    ),
    updated_at = now()
WHERE t.workflow_slug = 'formation_progress';

-- 3. Backfill task_meta.sd_stage / workflow_state to each task's SD CURRENT
--    (v2) stage so the pointer card shows the real stage. Joins by delivery_id
--    or task_meta.service_delivery_id (some tasks carry only the latter).
UPDATE tasks t
SET task_meta = COALESCE(t.task_meta, '{}'::jsonb)
                || jsonb_build_object('sd_stage', sd.stage, 'workflow_state', sd.stage),
    updated_at = now()
FROM service_deliveries sd
WHERE t.workflow_slug = 'formation_progress'
  AND sd.id = COALESCE(t.delivery_id, NULLIF(t.task_meta->>'service_delivery_id', '')::uuid);
