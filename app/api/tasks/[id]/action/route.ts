/**
 * POST /api/tasks/[id]/action — Generic workflow action dispatcher.
 *
 * Every workflow action (Approve, Needs Fix, Recall, etc.) routes through here.
 * One auth + RBAC + idempotency + optimistic-lock + audit path for the whole system.
 *
 * Flow:
 *   1. Auth (must be staff: admin | team)
 *   2. Load task; require workflow_snapshot present
 *   3. Validate snapshot shape
 *   4. Resolve action from snapshot.actions[]
 *   5. RBAC: caller's CrmRole must be in action.permission.role_in
 *   6. Validate task.task_meta against the workflow's Zod schema (if registered)
 *   7. Idempotency + optimistic lock: INSERT task_action_log row ON CONFLICT —
 *      if a prior row exists for (task_id, idempotency_key), return its result.
 *      If expected_status is provided and task.status differs, return 409.
 *   8. Resolve handler from registry
 *   9. Execute handler in mode='execute' or 'preview'
 *  10. On success: apply on_success_status + on_success_meta to task; spawn_task if any;
 *      update task_action_log to status='success' with side_effects + result.
 *  11. On failure: run rollbacks in reverse; write task_meta.last_error +
 *      workflow_state='Action Failed' (no status change per Decision A);
 *      update task_action_log to status='failed' (or 'partial' if rollback failed).
 *  12. Return JSON.
 *
 * See: sysdoc 'workflows-system-master-plan' §Architecture/Generic dispatcher,
 *      sysdoc 'ops-2026-05-15-workflow-system-slice-0-audit' Decisions A/B/C.
 */

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createWorkflowTask, updateTask } from "@/lib/operations/task"
import { getCrmRole, isDashboardUser } from "@/lib/auth"
import { parseWorkflowSnapshot } from "@/lib/tasks/workflow-snapshot-schema"
import { getWorkflowSchema } from "@/lib/tasks/workflow-schemas"
import { requireWorkflowHandler } from "@/lib/tasks/workflow-registry"
import type {
  HandlerContext,
  HandlerResult,
  SerializedSideEffect,
  SideEffect,
  TaskActionLogRow,
  TaskRow,
  WorkflowActionDefinition,
  WorkflowSnapshot,
} from "@/lib/tasks/types"

/**
 * task_action_log is not yet in the generated lib/database.types.ts (regen
 * pulls from production project ID and the migration has not been promoted
 * to production yet — see Slice 14). The from() type narrowing therefore
 * rejects the string literal. Cast via this helper until post-Slice-14 regen.
 */
function actionLogTable() {
  return (
    supabaseAdmin as unknown as {
      from: (t: "task_action_log") => {
        select: (cols?: string) => {
          eq: (col: string, val: unknown) => {
            eq: (col: string, val: unknown) => {
              maybeSingle: () => Promise<{ data: TaskActionLogRow | null; error: { message: string; code?: string } | null }>
              single: () => Promise<{ data: TaskActionLogRow | null; error: { message: string; code?: string } | null }>
            }
          }
        }
        insert: (row: Partial<TaskActionLogRow>) => {
          select: (cols?: string) => {
            single: () => Promise<{ data: TaskActionLogRow | null; error: { message: string; code?: string } | null }>
          }
        }
        update: (patch: Partial<TaskActionLogRow>) => {
          eq: (col: string, val: unknown) => Promise<{ error: { message: string; code?: string } | null }>
        }
      }
    }
  ).from("task_action_log")
}

const BodySchema = z.object({
  action_slug: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  idempotency_key: z.string().min(8).max(128),
  expected_status: z.enum(["To Do", "In Progress", "Waiting", "Done", "Cancelled"]).optional(),
  mode: z.enum(["execute", "preview"]).default("execute"),
})

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status })
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const taskId = params.id

  // ── 1. Auth ─────────────────────────────────────────────────────────
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return json({ error: "Unauthenticated" }, 401)
  if (!isDashboardUser(user)) return json({ error: "Dashboard access required" }, 403)
  const role = getCrmRole(user)
  if (!role) return json({ error: "No CRM role" }, 403)

  // ── 2. Parse body ───────────────────────────────────────────────────
  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json())
  } catch (err) {
    return json(
      { error: "Invalid request body", detail: err instanceof Error ? err.message : String(err) },
      422,
    )
  }

  // ── 3. Load task ────────────────────────────────────────────────────
  const { data: taskData, error: taskErr } = await supabaseAdmin
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle()
  if (taskErr) return json({ error: `Task load failed: ${taskErr.message}` }, 500)
  if (!taskData) return json({ error: "Task not found" }, 404)
  const task = taskData as TaskRow

  if (!task.workflow_snapshot) {
    return json({ error: "Task is not a workflow task (workflow_snapshot is null)" }, 400)
  }

  // ── 4. Parse + validate snapshot ────────────────────────────────────
  let snapshot: WorkflowSnapshot
  try {
    snapshot = parseWorkflowSnapshot(task.workflow_snapshot)
  } catch (err) {
    return json(
      { error: "Corrupt workflow_snapshot on task", detail: err instanceof Error ? err.message : String(err) },
      500,
    )
  }

  // ── 5. Resolve action ───────────────────────────────────────────────
  const action = snapshot.actions.find((a) => a.slug === body.action_slug)
  if (!action) {
    return json({ error: `Action '${body.action_slug}' not in workflow '${snapshot.slug}'` }, 404)
  }

  // ── 6. RBAC ─────────────────────────────────────────────────────────
  if (!action.permission.role_in.includes(role)) {
    return json({ error: `Role '${role}' not permitted for action '${action.slug}'` }, 403)
  }

  // ── 7. task_meta validation ────────────────────────────────────────
  const schema = getWorkflowSchema(snapshot.task_meta_schema)
  if (schema) {
    const result = schema.safeParse(task.task_meta ?? {})
    if (!result.success) {
      return json(
        {
          error: `task_meta failed validation for schema '${snapshot.task_meta_schema}'`,
          detail: result.error.message,
        },
        500,
      )
    }
  }

  // ── 8. Optimistic lock ─────────────────────────────────────────────
  if (body.expected_status && task.status !== body.expected_status) {
    return json(
      { error: "Task status moved since you loaded it", current_status: task.status },
      409,
    )
  }

  // ── 9. Preview mode short-circuit ──────────────────────────────────
  if (body.mode === "preview") {
    const handler = requireWorkflowHandler(action.handler)
    const ctx = await buildHandlerContext({
      task,
      snapshot,
      action,
      params: body.params,
      actor: user,
      idempotencyKey: body.idempotency_key,
      mode: "preview",
    })
    try {
      const result = await handler(ctx)
      return json({
        ok: true,
        mode: "preview",
        preview: result.preview ?? null,
        side_effects_planned: result.side_effects.map(serializeSideEffect),
      })
    } catch (err) {
      return json(
        { ok: false, mode: "preview", error: err instanceof Error ? err.message : String(err) },
        500,
      )
    }
  }

  // ── 10. Idempotency (INSERT-then-handle-conflict) ───────────────────
  const { data: existingLog } = await actionLogTable()
    .select("*")
    .eq("task_id", taskId)
    .eq("idempotency_key", body.idempotency_key)
    .maybeSingle()

  if (existingLog) {
    // Same key, same task — return the previous result regardless of age.
    return json({
      ok: existingLog.status === "success",
      idempotency_replay: true,
      log_id: existingLog.id,
      log_status: existingLog.status,
      result: existingLog.result,
      error: existingLog.error_message,
    })
  }

  const { data: insertedLog, error: insertErr } = await actionLogTable()
    .insert({
      task_id: taskId,
      workflow_slug: snapshot.slug,
      workflow_version: snapshot.version,
      action_slug: action.slug,
      actor_id: user.id,
      idempotency_key: body.idempotency_key,
      params: body.params as Record<string, unknown>,
      status: "pending",
    })
    .select("*")
    .single()

  if (insertErr) {
    // Race: another request inserted with the same key between SELECT and INSERT.
    // Re-read and return.
    if (insertErr.code === "23505") {
      const { data: raced } = await actionLogTable()
        .select("*")
        .eq("task_id", taskId)
        .eq("idempotency_key", body.idempotency_key)
        .single()
      return json({
        ok: raced?.status === "success",
        idempotency_replay: true,
        log_id: raced?.id,
        log_status: raced?.status,
        result: raced?.result,
        error: raced?.error_message,
      })
    }
    return json({ error: `Audit log insert failed: ${insertErr.message}` }, 500)
  }

  if (!insertedLog) return json({ error: "Audit log insert returned no row" }, 500)
  const logId = insertedLog.id

  // ── 11. Execute handler ─────────────────────────────────────────────
  const handler = requireWorkflowHandler(action.handler)
  const ctx = await buildHandlerContext({
    task,
    snapshot,
    action,
    params: body.params,
    actor: user,
    idempotencyKey: body.idempotency_key,
    mode: "execute",
  })

  let result: HandlerResult
  let handlerThrew: Error | null = null
  try {
    result = await handler(ctx)
  } catch (err) {
    handlerThrew = err instanceof Error ? err : new Error(String(err))
    result = {
      success: false,
      error: { code: "HANDLER_EXCEPTION", message: handlerThrew.message },
      side_effects: [],
    }
  }

  // ── 12. Persist outcome ────────────────────────────────────────────
  if (result.success) {
    return await finalizeSuccess({ task, snapshot, action, result, logId })
  } else {
    return await finalizeFailure({ task, result, logId, threw: handlerThrew })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

interface BuildCtxArgs {
  task: TaskRow
  snapshot: WorkflowSnapshot
  action: WorkflowActionDefinition
  params: unknown
  actor: HandlerContext["actor"]
  idempotencyKey: string
  mode: "execute" | "preview"
}

async function buildHandlerContext(args: BuildCtxArgs): Promise<HandlerContext> {
  // Service catalog resolution lands in Slice 5. Until then, serviceCatalog is null.
  return {
    task: args.task,
    workflow: args.snapshot,
    action: args.action,
    params: args.params,
    actor: args.actor,
    idempotencyKey: args.idempotencyKey,
    serviceCatalog: null,
    supabase: supabaseAdmin,
    mode: args.mode,
  }
}

function serializeSideEffect(se: SideEffect): SerializedSideEffect {
  return { kind: se.kind, detail: se.detail, ref_id: se.ref_id }
}

async function finalizeSuccess(args: {
  task: TaskRow
  snapshot: WorkflowSnapshot
  action: WorkflowActionDefinition
  result: HandlerResult
  logId: string
}) {
  const { task, action, result, logId } = args
  const now = new Date().toISOString()
  const nextStatus = result.next_status ?? action.on_success_status

  // Compose the task_meta update:
  //   existing meta (minus last_error)
  //   → handler.task_meta_patch (dynamic data: block note, sent message id, ...)
  //   → action.on_success_meta (catalog-declared final state — wins on conflict)
  const baseMeta = (task.task_meta ?? {}) as Record<string, unknown>
  const { last_error: _drop, ...metaWithoutError } = baseMeta as { last_error?: unknown }
  const nextMeta: Record<string, unknown> = {
    ...metaWithoutError,
    ...(result.task_meta_patch ?? {}),
    ...(action.on_success_meta ?? {}),
  }

  // updateTask auto-stamps completed_date when status flips to Done and writes
  // to action_log. task_meta is passed through the patch as a JSONB column.
  // task_patch from the handler is merged in for fields like assigned_to/due_date.
  const handlerPatch = (result.task_patch ?? {}) as Record<string, unknown>
  // Strip status / task_meta from handlerPatch — those come from the action contract.
  delete handlerPatch.status
  delete handlerPatch.task_meta
  const patch = {
    status: nextStatus,
    task_meta: nextMeta,
    ...handlerPatch,
  } as Parameters<typeof updateTask>[0]["patch"]
  const update = await updateTask({
    id: task.id,
    patch,
    actor: "workflow-dispatcher",
    summary: `Workflow ${action.slug} succeeded`,
    details: { workflow_slug: task.workflow_slug, action_slug: action.slug },
  })

  if (!update.success) {
    // Task didn't update — flip log to partial; the side-effects fired but the task didn't move.
    await actionLogTable()
      .update({
        status: "partial",
        result: (result.result ?? null) as Record<string, unknown> | null,
        side_effects: result.side_effects.map(serializeSideEffect),
        error_code: "TASK_UPDATE_FAILED",
        error_message: update.error ?? "updateTask failed",
        completed_at: now,
      })
      .eq("id", logId)
    return json(
      { ok: false, log_id: logId, error: `Task update failed after handler success: ${update.error}` },
      500,
    )
  }

  // Spawn downstream task if requested. The handler returns the workflow slug
  // and task_meta; the dispatcher inherits parent linkage (account / deal /
  // contact / service / delivery) and copies the parent's assigned_to unless
  // the handler overrides. The spawned task's workflow_snapshot is left null;
  // it will be filled by the auto-chain at the next dispatch (Slice 5).
  let spawnedTaskId: string | null = null
  if (result.spawn_task) {
    const spawn = await createWorkflowTask({
      workflow_slug: result.spawn_task.workflow_slug,
      workflow_snapshot: {},
      task_meta: result.spawn_task.task_meta,
      task_title: `[${result.spawn_task.workflow_slug}] (spawned from ${task.id.slice(0, 8)})`,
      assigned_to: result.spawn_task.assigned_to ?? task.assigned_to,
      account_id: task.account_id,
      deal_id: task.deal_id,
      service_id: task.service_id,
      delivery_id: task.delivery_id,
      contact_id: task.contact_id,
      actor: "workflow-dispatcher",
      summary: `Spawned by ${task.workflow_slug}/${action.slug}`,
      details: { parent_task_id: task.id, workflow_slug: result.spawn_task.workflow_slug },
    })
    if (!spawn.success) {
      console.warn(`[dispatcher] spawn_task failed: ${spawn.error}`)
    } else {
      spawnedTaskId = spawn.task_id ?? null
    }
  }

  await actionLogTable()
    .update({
      status: "success",
      result: ({
        ...(result.result ?? {}),
        ...(spawnedTaskId ? { spawned_task_id: spawnedTaskId } : {}),
        ...(result.transition ? { transition: result.transition } : {}),
      } as Record<string, unknown>),
      side_effects: result.side_effects.map(serializeSideEffect),
      completed_at: now,
    })
    .eq("id", logId)

  return json({
    ok: true,
    log_id: logId,
    next_status: nextStatus,
    transition: result.transition ?? null,
    spawned_task_id: spawnedTaskId,
    side_effects: result.side_effects.map(serializeSideEffect),
  })
}

async function finalizeFailure(args: {
  task: TaskRow
  result: HandlerResult
  logId: string
  threw: Error | null
}) {
  const { task, result, logId, threw } = args
  const now = new Date().toISOString()

  // Roll back side-effects in reverse order. Track rollback errors.
  const rollbackErrors: string[] = []
  for (let i = result.side_effects.length - 1; i >= 0; i--) {
    const se = result.side_effects[i]
    if (!se.rollback) continue
    try {
      await se.rollback()
    } catch (err) {
      rollbackErrors.push(`${se.kind}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Per Decision A: failure does NOT change task.status. Mark via task_meta.
  const baseMeta = (task.task_meta ?? {}) as Record<string, unknown>
  const nextMeta: Record<string, unknown> = {
    ...baseMeta,
    workflow_state: "Action Failed",
    last_error: {
      code: result.error?.code ?? (threw ? "HANDLER_EXCEPTION" : "HANDLER_FAILURE"),
      message: result.error?.message ?? (threw?.message ?? "Unknown failure"),
      at: now,
    },
  }

  await updateTask({
    id: task.id,
    patch: { task_meta: nextMeta } as Parameters<typeof updateTask>[0]["patch"],
    actor: "workflow-dispatcher",
    summary: `Workflow action failed`,
    details: {
      workflow_slug: task.workflow_slug,
      error_code: result.error?.code ?? (threw ? "HANDLER_EXCEPTION" : "HANDLER_FAILURE"),
    },
  })

  const finalStatus = rollbackErrors.length > 0 ? "partial" : "failed"

  await actionLogTable()
    .update({
      status: finalStatus,
      result: result.result ? (result.result as Record<string, unknown>) : null,
      side_effects: result.side_effects.map(serializeSideEffect),
      error_code: result.error?.code ?? (threw ? "HANDLER_EXCEPTION" : "HANDLER_FAILURE"),
      error_message:
        result.error?.message ?? (threw?.message ?? "Handler returned success=false"),
      partial_state: (result.error?.partial_state ?? null) as Record<string, unknown> | null,
      completed_at: now,
    })
    .eq("id", logId)

  return json(
    {
      ok: false,
      log_id: logId,
      log_status: finalStatus,
      error: result.error?.message ?? threw?.message ?? "Handler failed",
      rollback_errors: rollbackErrors.length > 0 ? rollbackErrors : undefined,
    },
    finalStatus === "partial" ? 500 : 400,
  )
}
