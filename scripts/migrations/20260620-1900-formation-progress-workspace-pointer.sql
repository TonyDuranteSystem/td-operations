-- formation_progress → workspace-pointer migration (dev_task fix/formation-task-sync, 2026-06-20)
--
-- The v2 Company Formation pipeline renamed every stage (Payment Confirmed,
-- Wizard Submitted, Filed with State, Articles Received, SS-4 Prepared,
-- SS-4 Signed, EIN Received). The formation_progress workflow still used the OLD
-- vocabulary (Data Collection / State Filing / EIN Application / EIN Submitted /
-- Post-Formation + Banking / Closing) in its catalog + every pinned task
-- snapshot, so its task-card action buttons gated on dead stage names and never
-- tracked the SD. Decision (Antonio, 2026-06-20): the /flows/[delivery_id]
-- workspace is now the single control surface, so the formation_progress task
-- card becomes a read-only POINTER to the workspace — it shows the current
-- stage + an "Open in Workspace" link and NO inline advance buttons.
--
-- This is data-only (DML). The card reads the new `workspace_pointer` flag and
-- ignores `actions` when it is set; the matching schema change
-- (lib/tasks/workflow-snapshot-schema.ts) allows an empty actions array only for
-- pointer workflows. advanceServiceDelivery now keeps task_meta.sd_stage /
-- workflow_state synced on every advance (lib/service-delivery.ts §6b).
--
-- Old action slugs being retired (for the record): verify_data_and_name,
-- confirm_state_filed, mark_ss4_generated, mark_ss4_faxed, confirm_ein_received,
-- confirm_oa_lease, mark_complete, needs_fix.

-- 1. Catalog: flip the formation_progress workflow definition to pointer mode +
--    drop the stale old-vocab actions. The slug lives on the `slug` COLUMN (not
--    in metadata — cf0cb867 rule), and a DIFFERENT catalog (whats_new_events)
--    shares the same slug, so we scope by catalog_id='task_workflows' to hit
--    ONLY the workflow definition.
UPDATE catalog_entries
SET metadata = metadata || '{"workspace_pointer": true, "actions": []}'::jsonb,
    updated_at = now()
WHERE slug = 'formation_progress'
  AND catalog_id = 'task_workflows';

-- 2. In-flight task snapshots: re-pin to pointer mode so existing
--    formation_progress task cards render as workspace pointers too.
UPDATE tasks
SET workflow_snapshot = workflow_snapshot || '{"workspace_pointer": true, "actions": []}'::jsonb,
    updated_at = now()
WHERE workflow_slug = 'formation_progress';

-- 3. Backfill task_meta.sd_stage / workflow_state to each task's SD CURRENT
--    (v2) stage, so the pointer card shows the real stage. Joins by delivery_id
--    or task_meta.service_delivery_id (some tasks carry only the latter).
UPDATE tasks t
SET task_meta = COALESCE(t.task_meta, '{}'::jsonb)
                || jsonb_build_object('sd_stage', sd.stage, 'workflow_state', sd.stage),
    updated_at = now()
FROM service_deliveries sd
WHERE t.workflow_slug = 'formation_progress'
  AND sd.id = COALESCE(t.delivery_id, NULLIF(t.task_meta->>'service_delivery_id', '')::uuid);
