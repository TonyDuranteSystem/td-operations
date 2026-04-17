/**
 * P1.6 — Service Delivery operation authority layer
 *
 * SINGLE SOURCE OF TRUTH for service_delivery INSERT and stage changes.
 *
 * Every `.from("service_deliveries").insert(...)` in the codebase must go
 * through `createSD` so that stage and stage_order are resolved from
 * `pipeline_stages` (the canonical per-service-type vocabulary) instead of
 * being hardcoded.
 *
 * Background — why this exists:
 * Before P1.6, five admin-action routes hardcoded `stage: "Data Collection"`
 * on SD inserts regardless of service_type. That value is only valid for
 * Company Formation / Client Onboarding / Company Closure / Banking Fintech /
 * ITIN. For CMRA (Lease Created), EIN (SS-4 Preparation), State Annual Report
 * (Upcoming), State RA Renewal (Upcoming), and Tax Return (Company Data
 * Pending / 1st Installment Paid) it is invalid — producing stuck SDs that
 * never advance (4 cases rescued in Phase 0; documented in
 * dev_task 6d2a2be1).
 *
 * Stage resolution rules:
 *   - If `target_stage` is provided, it must match a pipeline_stages row for
 *     that service_type.  The resolver is case-insensitive on stage_name.
 *   - If `target_stage_order` is also provided, it overrides the lookup
 *     (needed for Tax Return stage_order=-1 "Company Data Pending").
 *   - If neither is provided, the FIRST row (lowest stage_order) is used —
 *     for most service types this is stage_order=1, for Tax Return this is
 *     stage_order=-1 "Company Data Pending".
 *
 * Side-effects: createSD does NOT create auto-tasks.  Task creation is
 * handled by `advanceServiceDelivery` in lib/service-delivery.ts, which runs
 * when stage advances.  For creation-time tasks the caller must invoke
 * `advanceStage` after `createSD` OR use an explicit task insert.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWrite } from "@/lib/db"
import {
  advanceServiceDelivery,
  type AdvanceStageParams,
  type AdvanceStageResult,
} from "@/lib/service-delivery"

// ─── Types ─────────────────────────────────────────────

export interface CreateSDParams {
  service_type: string
  /** Display name — defaults to `${service_type}` if omitted. */
  service_name?: string
  account_id?: string | null
  contact_id?: string | null
  deal_id?: string | null
  /**
   * Override stage_name.  Must match a row in pipeline_stages for the given
   * service_type (case-insensitive).  Throws if it doesn't match.
   */
  target_stage?: string
  /**
   * Override stage_order.  Required only for contextual entry points like
   * Tax Return stage_order=-1 ("Company Data Pending").  When provided
   * alongside target_stage, validation is skipped.
   */
  target_stage_order?: number
  assigned_to?: string
  notes?: string
  /** Defaults to today (YYYY-MM-DD). */
  start_date?: string
  /** Defaults to "active". */
  status?: string
}

export interface CreateSDResult {
  id: string
  service_type: string
  service_name: string
  stage: string
  stage_order: number
  account_id: string | null
  contact_id: string | null
}

export interface AdvanceStageIfAtParams {
  delivery_id: string
  /** Only advance if current stage matches (case-sensitive, string or list). */
  if_current_stage: string | string[]
  target_stage?: string
  actor?: string
  notes?: string
  skip_tasks?: boolean
}

export interface AdvanceStageIfAtResult {
  advanced: boolean
  current_stage: string | null
  reason?: string
  result?: AdvanceStageResult
}

export interface CompleteSDParams {
  delivery_id: string
  actor?: string
  notes?: string
}

// ─── Internal: stage resolution ────────────────────────

async function resolveFirstStage(
  service_type: string,
): Promise<{ stage: string; stage_order: number }> {
  const { data: stages, error } = await supabaseAdmin
    .from("pipeline_stages")
    .select("stage_name, stage_order")
    .eq("service_type", service_type)
    .order("stage_order", { ascending: true })
    .limit(1)

  if (error) {
    throw new Error(
      `[createSD] pipeline_stages lookup failed for service_type="${service_type}": ${error.message}`,
    )
  }
  if (!stages?.length) {
    throw new Error(
      `[createSD] No pipeline_stages defined for service_type="${service_type}"`,
    )
  }
  return { stage: stages[0].stage_name, stage_order: stages[0].stage_order }
}

async function resolveNamedStage(
  service_type: string,
  target_stage: string,
): Promise<{ stage: string; stage_order: number }> {
  const { data: stages, error } = await supabaseAdmin
    .from("pipeline_stages")
    .select("stage_name, stage_order")
    .eq("service_type", service_type)
    .order("stage_order", { ascending: true })

  if (error || !stages?.length) {
    throw new Error(
      `[createSD] pipeline_stages lookup failed for service_type="${service_type}": ${error?.message || "no stages"}`,
    )
  }

  const match = stages.find(
    (s) => s.stage_name.toLowerCase() === target_stage.toLowerCase(),
  )
  if (!match) {
    throw new Error(
      `[createSD] Stage "${target_stage}" not valid for service_type="${service_type}". ` +
        `Available: ${stages.map((s) => s.stage_name).join(", ")}`,
    )
  }
  return { stage: match.stage_name, stage_order: match.stage_order }
}

// ─── createSD ──────────────────────────────────────────

/**
 * Create a service delivery with a validated stage.
 *
 * Replaces scattered `.from("service_deliveries").insert(...)` calls across
 * admin-action routes, activate-service, installment-handler, and 6 form-
 * completed handlers.  Guarantees that `stage` is a real pipeline_stages
 * value for the given service_type.
 */
export async function createSD(
  params: CreateSDParams,
): Promise<CreateSDResult> {
  let stage: string
  let stage_order: number

  if (params.target_stage && params.target_stage_order !== undefined) {
    // Both provided — caller is making an explicit contextual choice
    // (e.g. Tax Return stage_order=-1).  Trust them; validate only that
    // the service_type has at least one pipeline row so we fail fast on
    // typos.
    await resolveFirstStage(params.service_type) // throws if unknown type
    stage = params.target_stage
    stage_order = params.target_stage_order
  } else if (params.target_stage) {
    const resolved = await resolveNamedStage(
      params.service_type,
      params.target_stage,
    )
    stage = resolved.stage
    stage_order = resolved.stage_order
  } else {
    const first = await resolveFirstStage(params.service_type)
    stage = first.stage
    stage_order = first.stage_order
  }

  const service_name = params.service_name || params.service_type
  const start_date =
    params.start_date || new Date().toISOString().split("T")[0]

  const row = await dbWrite(
    supabaseAdmin
      .from("service_deliveries")
      .insert({
        service_type: params.service_type,
        service_name,
        account_id: params.account_id || null,
        contact_id: params.contact_id || null,
        deal_id: params.deal_id || null,
        stage,
        stage_order,
        status: params.status || "active",
        start_date,
        assigned_to: params.assigned_to || "Luca",
        notes: params.notes || null,
        stage_entered_at: new Date().toISOString(),
      })
      .select("id, service_type, service_name, stage, stage_order, account_id, contact_id")
      .single(),
    "service_deliveries.insert",
  )

  if (!row) {
    throw new Error("[createSD] insert returned null — unexpected dbWrite behavior")
  }

  return {
    id: row.id,
    service_type: row.service_type,
    service_name: row.service_name || service_name,
    stage: row.stage || stage,
    stage_order: row.stage_order ?? stage_order,
    account_id: row.account_id,
    contact_id: row.contact_id,
  }
}

// ─── advanceStage ──────────────────────────────────────

/**
 * Advance a service delivery to the next (or explicit target) stage.
 *
 * Thin re-export of `advanceServiceDelivery` from lib/service-delivery.ts
 * so that callers only need to import from `@/lib/operations/service-delivery`.
 * The underlying function handles: stage_history, auto-tasks, portal tier
 * upgrade, notifications, tax return sync, RA/AR renewal dates, closure
 * cascade, action log.
 */
export async function advanceStage(
  params: AdvanceStageParams,
): Promise<AdvanceStageResult> {
  return advanceServiceDelivery(params)
}

// ─── advanceStageIfAt ──────────────────────────────────

/**
 * Advance a service delivery ONLY IF its current stage matches a gate.
 *
 * Used by form-completed handlers that should advance from the "waiting for
 * data" stage but must not re-advance if the SD has already moved forward
 * (e.g. double form submission, manual advance by staff).  Safer than
 * calling advanceStage unconditionally.
 */
export async function advanceStageIfAt(
  params: AdvanceStageIfAtParams,
): Promise<AdvanceStageIfAtResult> {
  const { data: sd, error } = await supabaseAdmin
    .from("service_deliveries")
    .select("stage")
    .eq("id", params.delivery_id)
    .single()

  if (error || !sd) {
    return {
      advanced: false,
      current_stage: null,
      reason: `SD ${params.delivery_id} not found: ${error?.message || "unknown"}`,
    }
  }

  const acceptable = Array.isArray(params.if_current_stage)
    ? params.if_current_stage
    : [params.if_current_stage]
  const currentStage = sd.stage || ""

  if (!acceptable.includes(currentStage)) {
    return {
      advanced: false,
      current_stage: currentStage,
      reason: `Current stage "${currentStage}" not in gate [${acceptable.join(", ")}]`,
    }
  }

  const result = await advanceServiceDelivery({
    delivery_id: params.delivery_id,
    target_stage: params.target_stage,
    actor: params.actor,
    notes: params.notes,
    skip_tasks: params.skip_tasks,
  })

  return {
    advanced: result.success,
    current_stage: currentStage,
    result,
  }
}

// ─── completeSD ────────────────────────────────────────

/**
 * Advance a service delivery to its final stage ("Completed" for most
 * service types, "TR Filed" for Tax Return).  Resolves the final stage by
 * querying pipeline_stages — does NOT hardcode "Completed".
 */
export async function completeSD(
  params: CompleteSDParams,
): Promise<AdvanceStageResult> {
  const { data: sd, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("service_type, stage")
    .eq("id", params.delivery_id)
    .single()

  if (sdErr || !sd) {
    throw new Error(
      `[completeSD] SD ${params.delivery_id} not found: ${sdErr?.message || "unknown"}`,
    )
  }

  const { data: stages, error: stErr } = await supabaseAdmin
    .from("pipeline_stages")
    .select("stage_name, stage_order")
    .eq("service_type", sd.service_type)
    .order("stage_order", { ascending: false })
    .limit(1)

  if (stErr || !stages?.length) {
    throw new Error(
      `[completeSD] No pipeline_stages for service_type="${sd.service_type}": ${stErr?.message || "none"}`,
    )
  }

  const finalStage = stages[0].stage_name

  return advanceServiceDelivery({
    delivery_id: params.delivery_id,
    target_stage: finalStage,
    actor: params.actor,
    notes: params.notes,
  })
}

// ─── repairContactId (P3.3) ───────────────────────────

export interface RepairContactIdParams {
  /** Account whose SDs need contact_id repair. */
  account_id: string
  /**
   * Authoritative contact to write. If omitted, the first contact linked via
   * `account_contacts` for this account is used.
   */
  target_contact_id?: string
  /** If true, only repair SDs with status='active'. Defaults to false. */
  active_only?: boolean
}

export interface RepairContactIdResult {
  success: boolean
  account_id: string
  contact_id: string | null
  fixed: number
  error?: string
}

/**
 * Fix SDs on an account whose `contact_id` is null or mismatched.
 *
 * Selection predicate: every SD for `account_id` where
 * `contact_id IS NULL OR contact_id != target_contact_id`. If `active_only`
 * is true, restricted to `status='active'`.
 *
 * Why this helper exists in P3.3:
 * Previously, `client-health/actions.ts` ran raw `.update()` calls on
 * `service_deliveries` directly — tripping P2.4 rule 1 after the rule went
 * live. This helper gives the repair path a single import surface matching
 * other write helpers in this module.
 */
export async function repairContactId(
  params: RepairContactIdParams,
): Promise<RepairContactIdResult> {
  let contactId = params.target_contact_id

  if (!contactId) {
    const { data: link } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", params.account_id)
      .limit(1)
      .maybeSingle()
    contactId = link?.contact_id ?? undefined
  }

  if (!contactId) {
    return {
      success: false,
      account_id: params.account_id,
      contact_id: null,
      fixed: 0,
      error: "No contact linked to this account and no target_contact_id provided",
    }
  }

  let brokenQuery = supabaseAdmin
    .from("service_deliveries")
    .select("id")
    .eq("account_id", params.account_id)
    .or(`contact_id.is.null,contact_id.neq.${contactId}`)
  if (params.active_only) {
    brokenQuery = brokenQuery.eq("status", "active")
  }
  const { data: broken } = await brokenQuery

  if (!broken || broken.length === 0) {
    return {
      success: true,
      account_id: params.account_id,
      contact_id: contactId,
      fixed: 0,
    }
  }

  try {
    let updateQuery = supabaseAdmin
      .from("service_deliveries")
      .update({ contact_id: contactId, updated_at: new Date().toISOString() })
      .eq("account_id", params.account_id)
      .or(`contact_id.is.null,contact_id.neq.${contactId}`)
    if (params.active_only) {
      updateQuery = updateQuery.eq("status", "active")
    }
    await dbWrite(
      updateQuery,
      params.active_only
        ? "service_deliveries.update.repairContactId.active"
        : "service_deliveries.update.repairContactId",
    )
  } catch (err) {
    return {
      success: false,
      account_id: params.account_id,
      contact_id: contactId,
      fixed: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  return {
    success: true,
    account_id: params.account_id,
    contact_id: contactId,
    fixed: broken.length,
  }
}
