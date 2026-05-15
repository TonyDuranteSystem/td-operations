-- Workflow System — Slice 1 Foundation
--
-- Catalog-driven workflow infrastructure for admin tasks.
-- See: sysdoc 'ops-2026-05-15-workflow-system-slice-0-audit',
--      sysdoc 'workflows-system-master-plan',
--      dev_task e364e980-8474-4410-8a6c-08f7e24a675d.
--
-- This migration is idempotent: re-running it against an environment
-- where some of these objects already exist is a no-op.

BEGIN;

-- 1. tasks columns
--    workflow_slug: identifies which workflow this task implements.
--    workflow_snapshot: pinned-at-creation copy of the workflow definition,
--                       so mid-flight catalog edits do not change in-flight tasks.
--    task_meta: workflow-specific data (attachments, submission_id, workflow_state).
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS workflow_slug TEXT NULL,
  ADD COLUMN IF NOT EXISTS workflow_snapshot JSONB NULL,
  ADD COLUMN IF NOT EXISTS task_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_tasks_workflow_slug
  ON tasks(workflow_slug)
  WHERE workflow_slug IS NOT NULL;

-- 2. task_action_log table
--    Audit + idempotency source for every workflow action invocation.
--    The (task_id, idempotency_key) unique index guards against double-INSERT
--    even if the SELECT-based fast-path inside the dispatcher races.
CREATE TABLE IF NOT EXISTS task_action_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workflow_slug TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  action_slug TEXT NOT NULL,
  actor_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('pending','success','failed','partial')),
  result JSONB,
  side_effects JSONB DEFAULT '[]'::jsonb,
  error_code TEXT,
  error_message TEXT,
  partial_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_action_idempotency
  ON task_action_log(task_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_task_action_log_task
  ON task_action_log(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_action_log_workflow
  ON task_action_log(workflow_slug, created_at DESC);

-- 3. Realtime publication membership
--    The catalog cache invalidates on catalog_entries UPDATE/INSERT/DELETE.
--    TaskCard live-updates rely on tasks UPDATE events.
--    Idempotent: skip if already a member.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'catalog_entries'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.catalog_entries;
  END IF;
END$$;

-- 4. task_workflows catalog definition
--    Workflow definitions live as catalog_entries rows with this catalog_id.
--    Structured payload (label_admin, actions, sla, permission, attachment_template,
--    on_success_meta, etc.) lives in catalog_entries.metadata jsonb.
INSERT INTO catalog_definitions (id, display_name, description, admin_can_add_rows, tags_schema)
VALUES (
  'task_workflows',
  'Task Workflows',
  'Workflow definitions used by the catalog-driven task system. Each row defines one admin-task workflow (slug, label, actions, permissions, SLA, attachment template). Edit via the /catalog page. Snapshot-pinned into tasks.workflow_snapshot at task creation so mid-flight catalog edits do not change in-flight tasks.',
  true,
  NULL
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
