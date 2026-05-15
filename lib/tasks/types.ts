/**
 * Workflow System — shared types.
 *
 * The DB columns added in the Slice 1 migration (workflow_slug, workflow_snapshot,
 * task_meta on `tasks`; the entire `task_action_log` table) are not yet present
 * in lib/database.types.ts because `npm run gen:types` pulls from the production
 * project ID and the migration has not yet been promoted to production. Until
 * production is migrated, these types are defined here. After Slice 14 promotes
 * the migration to production and `gen:types` is re-run, the manual augments
 * here can be folded into the generated types.
 *
 * See: sysdoc 'ops-2026-05-15-workflow-system-slice-0-audit',
 *      sysdoc 'workflows-system-master-plan',
 *      dev_task e364e980-8474-4410-8a6c-08f7e24a675d.
 */

import type { User } from "@supabase/supabase-js"
import type { Database } from "@/lib/database.types"
import type { supabaseAdmin } from "@/lib/supabase-admin"

// ── DB row types (augmented while the generated types are pre-migration) ─

type GeneratedTaskRow = Database["public"]["Tables"]["tasks"]["Row"]

/** A task row with the Slice 1 columns surfaced. */
export type TaskRow = GeneratedTaskRow & {
  workflow_slug: string | null
  workflow_snapshot: Record<string, unknown> | null
  task_meta: Record<string, unknown>
}

/** Row shape for the new task_action_log table. */
export interface TaskActionLogRow {
  id: string
  task_id: string
  workflow_slug: string
  workflow_version: number
  action_slug: string
  actor_id: string
  idempotency_key: string
  params: Record<string, unknown>
  status: "pending" | "success" | "failed" | "partial"
  result: Record<string, unknown> | null
  side_effects: SerializedSideEffect[]
  error_code: string | null
  error_message: string | null
  partial_state: Record<string, unknown> | null
  created_at: string
  completed_at: string | null
}

// ── Workflow definition shape (lives in catalog_entries.metadata) ────────

/** A workflow's snapshot — the frozen-at-task-creation definition. */
export interface WorkflowSnapshot {
  slug: string
  version: number
  label_admin: string
  icon?: string
  default_assignee?: string
  default_priority?: "Urgent" | "High" | "Normal" | "Low"
  permission: WorkflowPermission
  attachment_template?: string
  task_meta_schema?: string
  auto_topic?: string
  sla?: { warn_hours: number; escalate_hours: number; escalate_to: string }
  actions: WorkflowActionDefinition[]
}

export interface WorkflowPermission {
  /** Allowed CRM roles. Empty array = nobody. Per Decision B (Slice 0 audit), default seed is ['admin','team']. */
  role_in: CrmRole[]
}

export type CrmRole = "admin" | "team"

export interface WorkflowActionDefinition {
  slug: string
  label_admin: string
  primary?: boolean
  icon?: string
  color?: string
  permission: WorkflowPermission
  handler: string
  handler_params?: Record<string, unknown>
  requires_input?: {
    field: string
    label?: string
    required?: boolean
    optional?: boolean
  }
  confirm?: { preview_template?: string; summary?: string }
  /** Coarse status to set when this action succeeds (one of the 5 enum values). */
  on_success_status: TaskStatus
  /** Per Decision A: declarative writes to task_meta on success (e.g. workflow_state). */
  on_success_meta?: Record<string, unknown>
}

export type TaskStatus = "To Do" | "In Progress" | "Waiting" | "Done" | "Cancelled"

// ── Handler contract ─────────────────────────────────────────────────────

export interface HandlerContext {
  task: TaskRow
  workflow: WorkflowSnapshot
  action: WorkflowActionDefinition
  params: unknown
  actor: User
  idempotencyKey: string
  /** Resolved service catalog row + workflow_chain. Slice 5 makes this always-present; null until then. */
  serviceCatalog: ServiceCatalogResolved | null
  supabase: typeof supabaseAdmin
  mode: "execute" | "preview"
}

export interface ServiceCatalogResolved {
  slug: string
  workflow_chain: Record<string, unknown>
}

/** A side-effect a handler has fired (or intends to fire in preview mode). */
export interface SideEffect {
  kind: string
  detail: string
  ref_id?: string
  rollback?: () => Promise<void>
}

/** Serialized form of a side-effect (rollback is not persisted). */
export type SerializedSideEffect = Pick<SideEffect, "kind" | "detail" | "ref_id">

export interface HandlerResult {
  success: boolean
  /** Which transition key the service catalog chain should fire (Slice 5+). */
  transition?: string
  error?: { code: string; message: string; partial_state?: Record<string, unknown> }
  side_effects: SideEffect[]
  /** Override the action's on_success_status (rare — typically the action's value is used). */
  next_status?: TaskStatus
  /** Spawn a downstream task (Slice 2's chain.spawn_next_workflow uses this). */
  spawn_task?: { workflow_slug: string; task_meta: Record<string, unknown>; assigned_to?: string }
  /** Arbitrary handler return payload persisted to task_action_log.result. */
  result?: Record<string, unknown>
  /** Preview payload — populated only when ctx.mode === 'preview'. */
  preview?: {
    email_html?: string
    portal_message?: string
    sd_stage_change?: string
    documents?: Array<Record<string, unknown>>
  }
}

export type WorkflowHandler = (ctx: HandlerContext) => Promise<HandlerResult>
