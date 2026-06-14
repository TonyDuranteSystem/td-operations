/**
 * moveServiceDeliveryToStage — the flow Workspace clickable-stepper move.
 *
 * The stepper is a SHORTCUT for the stage action buttons + Go Back: clicking a
 * stage must fire ALL the real side effects, not a silent position change. So
 * this orchestrator dispatches by direction:
 *
 *   - FORWARD  → ONE `advanceServiceDelivery({ target_stage })` call. That is
 *     exactly what an action button does: it creates the target stage's
 *     auto-tasks, fires the client portal notification, and runs completion
 *     logic (status=completed + end_date, and the +1-year renewal-date bump for
 *     State Annual Report / State RA Renewal reaching "Closed"). We do NOT
 *     iterate forward — that would fire one client notification per intermediate
 *     stage (spam). A multi-stage forward jump is a single hop to the target,
 *     identical to pressing the action button that lands there.
 *
 *   - BACKWARD → iterate `revertServiceDelivery` one stage at a time until the
 *     SD reaches the target. Each step deletes the documents stamped with the
 *     re-opened stage and, when leaving a "Closed" renewal final, undoes that
 *     stage's +1-year renewal-date bump. (revert deliberately does not notify
 *     the client — same as the Go Back button.)
 *
 * Direction is decided by stage_order resolved from pipeline_stages by NAME (the
 * SD's own stage_order is frequently NULL/stale). Same stage → no-op.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { advanceServiceDelivery } from "@/lib/service-delivery"
import { revertServiceDelivery } from "@/lib/operations/service-delivery"

export interface MoveStageParams {
  delivery_id: string
  /** Target stage NAME (case-insensitive). Must exist in the SD's pipeline. */
  target_stage: string
  actor?: string
  notes?: string
}

export interface MoveStageResult {
  success: boolean
  outcome:
    | "advanced"
    | "reverted"
    | "same_stage"
    | "stage_not_found"
    | "not_found"
    | "requires_approval"
    | "error"
  delivery_id: string
  direction?: "forward" | "backward"
  from_stage?: string
  to_stage?: string
  to_order?: number
  /** Forward: target was a terminal stage and the SD was completed. */
  completed?: boolean
  /** Forward: titles of auto-tasks created by the advance. */
  created_tasks?: string[]
  /** Backward: total documents deleted across the reverted stages. */
  documents_deleted?: number
  /** Backward: a +1-year renewal-date bump was undone leaving "Closed". */
  renewal_date_reverted?: boolean
  error?: string
}

export async function moveServiceDeliveryToStage(
  params: MoveStageParams,
): Promise<MoveStageResult> {
  const actor = params.actor || "system"

  // 1. Load the SD (current stage) and the pipeline.
  const { data: sd, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("id, service_type, stage")
    .eq("id", params.delivery_id)
    .maybeSingle()

  if (sdErr) {
    return { success: false, outcome: "error", delivery_id: params.delivery_id, error: sdErr.message }
  }
  if (!sd) {
    return { success: false, outcome: "not_found", delivery_id: params.delivery_id, error: "Service delivery not found" }
  }

  const { data: stages, error: stErr } = await supabaseAdmin
    .from("pipeline_stages")
    .select("stage_name, stage_order")
    .eq("service_type", sd.service_type)
    .order("stage_order", { ascending: true })

  if (stErr || !stages?.length) {
    return {
      success: false,
      outcome: "error",
      delivery_id: sd.id,
      error: `No pipeline stages for service_type "${sd.service_type}"`,
    }
  }

  // 2. Resolve the target by NAME (case-insensitive).
  const target = stages.find(
    (s) => s.stage_name.toLowerCase() === params.target_stage.toLowerCase(),
  )
  if (!target) {
    return {
      success: false,
      outcome: "stage_not_found",
      delivery_id: sd.id,
      error: `Stage "${params.target_stage}" is not part of the "${sd.service_type}" pipeline.`,
    }
  }

  // 3. No-op when already at the target.
  if (sd.stage && sd.stage.toLowerCase() === target.stage_name.toLowerCase()) {
    return {
      success: true,
      outcome: "same_stage",
      delivery_id: sd.id,
      from_stage: sd.stage,
      to_stage: target.stage_name,
      to_order: target.stage_order,
    }
  }

  const current = stages.find((s) => s.stage_name === sd.stage)
  if (!current) {
    return {
      success: false,
      outcome: "error",
      delivery_id: sd.id,
      from_stage: sd.stage ?? undefined,
      error: `Current stage "${sd.stage}" is not part of the "${sd.service_type}" pipeline.`,
    }
  }

  // 4a. FORWARD — single full-side-effect advance to the target.
  if (target.stage_order > current.stage_order) {
    const adv = await advanceServiceDelivery({
      delivery_id: params.delivery_id,
      target_stage: target.stage_name,
      actor,
      notes: params.notes,
    })
    if (!adv.success) {
      return {
        success: false,
        outcome: adv.requires_approval ? "requires_approval" : "error",
        delivery_id: sd.id,
        direction: "forward",
        from_stage: adv.from_stage,
        to_stage: target.stage_name,
        to_order: target.stage_order,
        error: adv.error || "Could not advance to this stage.",
      }
    }
    return {
      success: true,
      outcome: "advanced",
      delivery_id: sd.id,
      direction: "forward",
      from_stage: adv.from_stage,
      to_stage: adv.to_stage,
      to_order: adv.to_order,
      completed: adv.is_completed,
      created_tasks: adv.created_tasks,
    }
  }

  // 4b. BACKWARD — iterate revert one stage at a time until reaching the target.
  let currentName: string | null = sd.stage
  let documentsDeleted = 0
  let renewalReverted = false
  const maxSteps = stages.length + 1 // bound: cannot exceed the pipeline length

  for (let i = 0; i < maxSteps; i++) {
    if (currentName && currentName.toLowerCase() === target.stage_name.toLowerCase()) break
    const r = await revertServiceDelivery({ delivery_id: params.delivery_id, actor, notes: params.notes })
    if (!r.success) {
      return {
        success: false,
        outcome: "error",
        delivery_id: sd.id,
        direction: "backward",
        from_stage: sd.stage ?? undefined,
        to_stage: currentName ?? undefined,
        documents_deleted: documentsDeleted,
        error: r.error || "Could not step back to the target stage.",
      }
    }
    documentsDeleted += r.documents_deleted ?? 0
    if (r.renewal_date_reverted) renewalReverted = true
    currentName = r.to_stage ?? null
  }

  if (!currentName || currentName.toLowerCase() !== target.stage_name.toLowerCase()) {
    return {
      success: false,
      outcome: "error",
      delivery_id: sd.id,
      direction: "backward",
      from_stage: sd.stage ?? undefined,
      to_stage: currentName ?? undefined,
      documents_deleted: documentsDeleted,
      error: "Could not reach the target stage going backward.",
    }
  }

  return {
    success: true,
    outcome: "reverted",
    delivery_id: sd.id,
    direction: "backward",
    from_stage: sd.stage ?? undefined,
    to_stage: target.stage_name,
    to_order: target.stage_order,
    documents_deleted: documentsDeleted,
    renewal_date_reverted: renewalReverted,
  }
}
