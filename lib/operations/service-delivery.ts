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
 * Side-effects (Phase 9, 2026-05-18): after a successful insert, createSD
 * fires the workflow dispatcher (`dispatchWorkflowForSdCreated`). If a
 * `task_workflows` row matches the service_type a workflow task is spawned;
 * if no row matched a plain fallback task is created so every SD has at least
 * one tracked task. Both paths are fire-and-forget — failures do NOT roll
 * back the SD insert.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWrite, dbWriteSafe } from "@/lib/db"
import {
  advanceServiceDelivery,
  type AdvanceStageParams,
  type AdvanceStageResult,
} from "@/lib/service-delivery"
import {
  VALID_SERVICE_TYPES,
  isValidServiceType,
  type ValidServiceType,
} from "@/lib/operations/service-types"
import { getEntryByServiceType, isPerPersonServiceType } from "@/lib/services"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"
import { updateTasksBulk } from "@/lib/operations/task"
import { updateAccount } from "@/lib/operations/account"
import { logAction } from "@/lib/mcp/action-log"

// Re-export so existing import paths keep working.
export { VALID_SERVICE_TYPES, isValidServiceType }
export type { ValidServiceType }

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
  /**
   * Optional pricing carried from offers. When set, both fields should be
   * provided together (Phase 4 Step 3 — needed for onboarding-setup which
   * derives pricing from the offer at SD creation time).
   */
  amount?: number
  amount_currency?: string
  /**
   * Originating offer token. For contact-scoped "Company Formation" SDs this is
   * the dedup key enforced by the partial unique index
   * uq_formation_sd_active_per_offer — set it so a concurrent/retried activation
   * cannot create a duplicate formation. Harmless (stored, not constrained) for
   * other service types.
   */
  source_offer_token?: string | null
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
  /** Suppress client-facing notifications (bulk reconcile/backfill). */
  skip_notify?: boolean
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
 * Primary linked contact for an account: is_primary=true first, contact_id
 * alphabetical as a stable tiebreaker (`account_contacts` has no created_at).
 * Shared by the ITIN forced-resolution and the non-ITIN person-link hygiene
 * in createSD. Returns null when the account has no linked contacts.
 */
async function resolvePrimaryContactId(accountId: string): Promise<string | null> {
  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, is_primary")
    .eq("account_id", accountId)
    .order("is_primary", { ascending: false })
    .order("contact_id", { ascending: true })
    .limit(1)
  return links?.[0]?.contact_id ?? null
}

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
  // ITIN architectural rule (Phase 1, 2026-05-11): ITIN SDs always live on
  // contact_id with account_id=null, even when the contact owns an LLC. The
  // ITIN belongs to the person, not the company. Enforce here so every entry
  // point (activate-service, MCP sd_create, CRM create-service, future callers)
  // gets the same shape automatically.
  //
  // Phase B (2026-05-11): when only account_id is supplied (admin-created ITIN
  // SD from the CRM), auto-resolve the contact_id from account_contacts so the
  // caller doesn't have to know the architectural rule. Picks the primary
  // contact (is_primary=true) with contact_id alphabetical as a stable
  // tiebreaker — `account_contacts` does not store a created_at column.
  if (params.service_type === "ITIN") {
    if (!params.contact_id && params.account_id) {
      const resolvedContactId = await resolvePrimaryContactId(params.account_id)
      if (!resolvedContactId) {
        throw new Error(
          `[createSD] service_type="ITIN" with account_id=${params.account_id} has no linked contacts in account_contacts. Link a contact to the account first, or pass contact_id explicitly.`,
        )
      }
      params = { ...params, contact_id: resolvedContactId, account_id: null }
    } else if (!params.contact_id) {
      throw new Error(
        `[createSD] service_type="ITIN" requires contact_id (account_id is forced to null per Phase 1 ITIN rule)`,
      )
    } else if (params.account_id) {
      params = { ...params, account_id: null }
    }
  } else if (!params.contact_id && params.account_id) {
    // Person-link hygiene (2026-07-06, Prowave What's New incident follow-up):
    // non-ITIN SDs created with only an account_id also get contact_id
    // auto-resolved (same primary-contact heuristic as the ITIN block above),
    // KEEPING account_id set. Downstream the sd_created workflow dispatcher
    // tags its What's New note with both ids, so the note reaches the primary
    // contact's person thread directly instead of relying on the query-side
    // company fan-out. Best-effort: an account with no linked contacts leaves
    // contact_id null — never blocks SD creation.
    const resolvedContactId = await resolvePrimaryContactId(params.account_id)
    if (resolvedContactId) {
      params = { ...params, contact_id: resolvedContactId }
    }
  }

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

  // Phase 0.3 (dev_task tax-pause-refactor): propagate is_test from the
  // account so test-account SDs are filterable by the standard
  // excludeTestRecords helper. Without this, cron jobs and audits see test
  // data mixed in with real client work. When account_id is null (standalone
  // contact purchase), check contacts.is_test instead.
  let is_test = false
  if (params.account_id) {
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select("is_test")
      .eq("id", params.account_id)
      .maybeSingle()
    if (acct?.is_test === true) is_test = true
  } else if (params.contact_id) {
    const { data: c } = await supabaseAdmin
      .from("contacts")
      .select("is_test")
      .eq("id", params.contact_id)
      .maybeSingle()
    if (c?.is_test === true) is_test = true
  }

  // Catalog Framework Phase 4 Step 1: resolve the catalog FK from the
  // service_type text so new SDs match the Phase 2 backfill (alias map in
  // lib/services/index.ts mirrors 20260510-catalog-backfill.sql §1).
  // Graceful: unmapped types stay null with a warning so legitimate but
  // not-yet-mapped service types (Support, Client Offboarding) still insert.
  let service_type_entry_id: string | null = null
  try {
    const entry = await getEntryByServiceType(params.service_type)
    if (entry) {
      service_type_entry_id = entry.id
    } else {
      console.warn(
        `[createSD] no catalog entry for service_type="${params.service_type}" — service_type_entry_id left null`,
      )
    }
  } catch (err) {
    console.warn(
      `[createSD] catalog lookup failed for service_type="${params.service_type}":`,
      err,
    )
  }

  const row = await dbWrite(
    supabaseAdmin
      .from("service_deliveries")
      .insert({
        service_type: params.service_type,
        service_type_entry_id,
        service_name,
        account_id: params.account_id || null,
        contact_id: params.contact_id || null,
        deal_id: params.deal_id || null,
        stage,
        stage_order,
        status: params.status || "active",
        start_date,
        assigned_to: params.assigned_to || defaultTaskAssignee(),
        notes: params.notes || null,
        source_offer_token: params.source_offer_token ?? null,
        stage_entered_at: new Date().toISOString(),
        is_test,
        ...(params.amount != null && {
          amount: params.amount,
          amount_currency: params.amount_currency || "USD",
        }),
      })
      .select("id, service_type, service_name, stage, stage_order, account_id, contact_id")
      .single(),
    "service_deliveries.insert",
  )

  if (!row) {
    throw new Error("[createSD] insert returned null — unexpected dbWrite behavior")
  }

  // ─── Slice 9: dispatch sd_created workflows ──────────────────────────
  //
  // Auto-spawn workflow tasks for SD-lifecycle workflows (closure_progress,
  // formation_progress, onboarding_progress) whose triggered_by predicate
  // matches the new SD's service_type. Fire-and-forget with try/catch so any
  // dispatcher failure does NOT roll back the SD insert — createSD must
  // remain robust for callers that don't care about workflows.
  //
  // The dispatcher's own idempotency check (task_meta.service_delivery_id)
  // ensures retries can't spawn duplicate workflow tasks. Service types
  // with no matching task_workflows row return no_trigger_match (silent).
  let workflowSpawned = false
  try {
    const { dispatchWorkflowForSdCreated } = await import(
      "@/lib/tasks/dispatch-workflow-for-event"
    )
    const dispatchResult = await dispatchWorkflowForSdCreated({
      delivery: {
        id: row.id,
        service_type: row.service_type,
        stage: row.stage,
        account_id: row.account_id,
        contact_id: row.contact_id,
        service_name: row.service_name ?? null,
      },
      build_task_meta: async () => ({
        service_delivery_id: row.id,
        account_id: row.account_id,
        contact_id: row.contact_id,
        sd_stage: row.stage,
        service_type: row.service_type,
      }),
      task_title: `${row.service_type} — ${row.service_name || row.service_type}`,
      description: `Service delivery created: ${row.service_type}. Use the action buttons below to advance the lifecycle.`,
      actor: "createSD:auto-spawn",
    })
    if (dispatchResult.spawned || dispatchResult.reason === "already_spawned") {
      workflowSpawned = true
    }
  } catch (err) {
    console.warn(
      `[createSD] workflow dispatcher failed (non-fatal) for SD ${row.id} (${row.service_type}):`,
      err instanceof Error ? err.message : String(err),
    )
  }

  // Universal task per SD (2026-05-18, per Antonio). When no workflow row
  // matches this service_type, fall back to creating a plain task so every
  // service has at least one tracked task visible in the portal-chats
  // per-thread Tasks panel + the Task Board. Fire-and-forget — task failure
  // does NOT roll back the SD insert. Title mirrors the workflow path so
  // both surfaces present the same name.
  if (!workflowSpawned) {
    try {
      const { dbWriteSafe } = await import("@/lib/db")
      // eslint-disable-next-line no-restricted-syntax -- universal-task fallback for SDs without workflow rows
      await dbWriteSafe(
        supabaseAdmin.from("tasks").insert({
          task_title: `${row.service_type} — ${row.service_name || row.service_type}`,
          description: `Service delivery created: ${row.service_type}. No workflow defined for this service type yet — add one via /service-catalog/[slug]/edit so future ${row.service_type} services get action buttons.`,
          assigned_to: params.assigned_to || defaultTaskAssignee(),
          priority: "Normal",
          status: "To Do",
          account_id: row.account_id ?? undefined,
          contact_id: row.contact_id ?? undefined,
          delivery_id: row.id,
          created_by: "System",
        }),
        "tasks.insert.universal-sd-fallback",
      )
    } catch (err) {
      console.warn(
        `[createSD] universal-task fallback failed (non-fatal) for SD ${row.id} (${row.service_type}):`,
        err instanceof Error ? err.message : String(err),
      )
    }
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

// ─── createBackfilledSD ────────────────────────────────

export interface CreateBackfilledSDParams {
  /** Exactly one of account_id / contact_id must be set. */
  account_id?: string
  /** Exactly one of account_id / contact_id must be set. */
  contact_id?: string
  service_type: string
  service_name?: string
  amount: number
  amount_currency: string
  /** Both start and end_date set to this value (the historical event date). */
  delivered_on: string
  notes?: string
}

export interface CreateBackfilledSDResult {
  id: string
  service_type: string
  service_name: string
}

/**
 * Backfill a completed/Delivered service delivery for a historical paid event.
 *
 * Used by:
 *   - The audit panel's "Create service from bank feed" flow (account-scoped).
 *   - The bank-feed-tab modal's "Create new service" branch (account or
 *     contact target — Bank-feed Tier B redesign 2026-05-05).
 *
 * Differs from `createSD` in three ways:
 *   1. Does NOT consult `pipeline_stages` — the caller may pass a service_type
 *      that has no pipeline (e.g. "Shipping", "Public Notary", "Support" —
 *      one-off services that never enter a tracked pipeline).
 *   2. Inserts directly at status='completed' (lowercase, per
 *      `chk_sd_status`), stage='Delivered' (free-text marker — no
 *      stage constraint exists).
 *   3. Carries amount + currency from the originating event.
 *
 * Validates `service_type` against `VALID_SERVICE_TYPES` server-side as
 * defense-in-depth so a UI bypass cannot reach the DB constraint and produce
 * a confusing 23514 error. Also enforces the account_id XOR contact_id rule
 * — exactly one must be set, mirroring the table's nullable column shape and
 * the formation architecture rule "ownership = whoever paid, never migrates".
 *
 * The `is_test` flag is propagated from whichever parent entity is set so
 * test-target SDs stay filterable by the standard `excludeTestRecords` helper.
 */
export async function createBackfilledSD(
  params: CreateBackfilledSDParams,
): Promise<CreateBackfilledSDResult> {
  // XOR validation — exactly one target id must be set.
  const hasAccount = typeof params.account_id === "string" && params.account_id.length > 0
  const hasContact = typeof params.contact_id === "string" && params.contact_id.length > 0
  if (hasAccount && hasContact) {
    throw new Error(
      "[createBackfilledSD] pass account_id OR contact_id, not both",
    )
  }
  if (!hasAccount && !hasContact) {
    throw new Error(
      "[createBackfilledSD] account_id or contact_id required",
    )
  }

  if (!isValidServiceType(params.service_type)) {
    throw new Error(
      `[createBackfilledSD] invalid service_type "${params.service_type}". ` +
        `Allowed: ${VALID_SERVICE_TYPES.join(", ")}`,
    )
  }

  const service_name = params.service_name || params.service_type

  let is_test = false
  if (hasAccount) {
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select("is_test")
      .eq("id", params.account_id!)
      .maybeSingle()
    if (acct?.is_test === true) is_test = true
  } else {
    const { data: c } = await supabaseAdmin
      .from("contacts")
      .select("is_test")
      .eq("id", params.contact_id!)
      .maybeSingle()
    if (c?.is_test === true) is_test = true
  }

  const row = await dbWrite(
    supabaseAdmin
      .from("service_deliveries")
      .insert({
        service_type: params.service_type,
        service_name,
        account_id: params.account_id ?? null,
        contact_id: params.contact_id ?? null,
        status: "completed",
        stage: "Delivered",
        start_date: params.delivered_on,
        end_date: params.delivered_on,
        amount: params.amount,
        amount_currency: params.amount_currency,
        notes: params.notes ?? null,
        stage_entered_at: new Date().toISOString(),
        is_test,
      })
      .select("id, service_type, service_name")
      .single(),
    "service_deliveries.insert.backfill",
  )

  if (!row) {
    throw new Error("[createBackfilledSD] insert returned null")
  }

  return {
    id: row.id,
    service_type: row.service_type,
    service_name: row.service_name || service_name,
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
    skip_notify: params.skip_notify,
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

// ─── completeSDInPlace ────────────────────────────────

/**
 * Mark a service delivery completed WITHOUT changing its stage.
 *
 * For flows whose terminal stage is not named "Completed" (e.g. ITIN, whose
 * last stage is "ITIN Approved"), `advanceServiceDelivery` never flips
 * status=completed — its completion rule keys off the stage NAME. Re-advancing
 * into the same stage is not an option either: it would re-fire the generic
 * "status updated" client notification. This helper completes the SD in
 * place: status → completed, end_date stamped, a stage_history entry appended.
 *
 * TOCTOU-guarded on status='active' — returns { completed: false } when the
 * SD was already completed/cancelled (or completed concurrently), so callers
 * can gate one-shot side effects (client notifications) on the winning call.
 */
export async function completeSDInPlace(
  deliveryId: string,
  opts: { actor?: string; notes?: string } = {},
): Promise<{ completed: boolean }> {
  const { data: sd, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("id, status, stage, stage_order, stage_history")
    .eq("id", deliveryId)
    .single()

  if (sdErr || !sd) {
    throw new Error(`[completeSDInPlace] SD ${deliveryId} not found: ${sdErr?.message || "unknown"}`)
  }
  if (sd.status !== "active") return { completed: false }

  const historyEntry = {
    from_stage: sd.stage || "New",
    from_order: sd.stage_order ?? null,
    to_stage: sd.stage || "New",
    to_order: sd.stage_order ?? null,
    advanced_at: new Date().toISOString(),
    advanced_by: opts.actor ?? "system",
    notes: opts.notes ?? "Completed in place (terminal stage)",
  }
  const stageHistory = Array.isArray(sd.stage_history) ? [...sd.stage_history, historyEntry] : [historyEntry]

  const rows = await dbWrite(
    supabaseAdmin
      .from("service_deliveries")
      .update({
        status: "completed",
        end_date: new Date().toISOString().split("T")[0],
        stage_history: stageHistory,
        updated_at: new Date().toISOString(),
      })
      .eq("id", deliveryId)
      .eq("status", "active")
      .select("id"),
    "service_deliveries.update.complete_in_place",
  )

  return { completed: Array.isArray(rows) && rows.length > 0 }
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

// ─── deactivateSD / reactivateSD ───────────────────────

/**
 * Service types whose renewal is driven by an account-level date AND a nightly
 * cron that auto-creates the SD when the date is within 30 days and no active
 * SD exists (app/api/cron/ra-renewal-check + annual-report-check). For these,
 * cancelling the SD alone is NOT permanent on a `Client` account — the cron
 * re-creates it. Clearing the account date (clear_renewal_date) is what stops
 * it. Maps service_type → the accounts column the cron reads.
 */
const RENEWAL_DATE_COLUMN: Record<string, "ra_renewal_date" | "annual_report_due_date"> = {
  "State RA Renewal": "ra_renewal_date",
  "State Annual Report": "annual_report_due_date",
}

/** Task statuses considered "open" — closed on deactivate. */
/** Every task status that counts as still-open. Exported so callers writing
 *  their own "is there already an open task?" guard cannot omit one — a guard
 *  that missed "Waiting" is exactly how a duplicate follow-up task slipped
 *  through (2026-07-20). Never hand-roll this list. */
export const OPEN_TASK_STATUSES = ["To Do", "In Progress", "Waiting"] as const

function isRenewalServiceType(serviceType: string): boolean {
  return serviceType in RENEWAL_DATE_COLUMN
}

export interface DeactivateSDParams {
  delivery_id: string
  actor?: string
  /** Free-text reason, appended to SD notes + logged. */
  reason?: string
  /**
   * When true AND the service is a renewal type (State RA Renewal / State
   * Annual Report) with an account_id, also clear that account's renewal date
   * so the nightly cron won't re-create the SD. No-op for non-renewal types.
   */
  clear_renewal_date?: boolean
  /** Optimistic-lock sentinel — observed SD.updated_at when the page rendered. */
  expected_updated_at?: string
}

export interface DeactivateSDResult {
  success: boolean
  outcome: "deactivated" | "already_terminal" | "stale" | "not_found" | "error"
  delivery_id: string
  service_type?: string
  tasks_cancelled?: number
  renewal_date_cleared?: boolean
  error?: string
}

/**
 * Deactivate (cancel) a service delivery.
 *
 * Sets status='cancelled', stamps end_date, cancels the service's open tasks,
 * and — when asked for a renewal service type — clears the account-level
 * renewal date so the nightly cron stops managing it. Cancelled SDs leave the
 * account "Active" list and the client portal automatically (portal queries
 * filter status IN active|completed).
 *
 * Clean no-op if the SD is already cancelled/completed.
 */
export async function deactivateSD(
  params: DeactivateSDParams,
): Promise<DeactivateSDResult> {
  const actor = params.actor || "system"

  const { data: sd, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("id, service_type, service_name, status, account_id, contact_id, updated_at, notes")
    .eq("id", params.delivery_id)
    .maybeSingle()

  if (sdErr) {
    return { success: false, outcome: "error", delivery_id: params.delivery_id, error: sdErr.message }
  }
  if (!sd) {
    return { success: false, outcome: "not_found", delivery_id: params.delivery_id, error: "Service delivery not found" }
  }
  if (params.expected_updated_at && sd.updated_at !== params.expected_updated_at) {
    return {
      success: false,
      outcome: "stale",
      delivery_id: params.delivery_id,
      service_type: sd.service_type,
      error: "This service has been updated since you opened the page. Refresh and try again.",
    }
  }
  if (sd.status === "cancelled" || sd.status === "completed") {
    return {
      success: false,
      outcome: "already_terminal",
      delivery_id: params.delivery_id,
      service_type: sd.service_type,
      error: `Service is already ${sd.status} — nothing to deactivate.`,
    }
  }

  const today = new Date().toISOString().split("T")[0]
  const noteLine = `${today} — Service deactivated${params.reason ? `: ${params.reason}` : ""}`
  const newNotes = sd.notes ? `${sd.notes}\n${noteLine}` : noteLine

  // SD status write — guarded by expected_updated_at (TOCTOU) when supplied,
  // else by the non-terminal status we just read.
  let statusQuery = supabaseAdmin
    .from("service_deliveries")
    .update({
      status: "cancelled",
      end_date: today,
      notes: newNotes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sd.id)
  statusQuery = params.expected_updated_at
    ? statusQuery.eq("updated_at", params.expected_updated_at)
    : statusQuery.eq("status", sd.status)
  const updated = await dbWrite(statusQuery.select("id").maybeSingle(), "service_deliveries.update.deactivate")
  if (!updated) {
    return {
      success: false,
      outcome: "stale",
      delivery_id: params.delivery_id,
      service_type: sd.service_type,
      error: "This service was modified concurrently. Refresh and try again.",
    }
  }

  // Cancel the service's open tasks so no orphan work remains on the board.
  let tasksCancelled = 0
  const taskResult = await updateTasksBulk({
    delivery_id: sd.id,
    status_in: [...OPEN_TASK_STATUSES],
    patch: { status: "Cancelled" },
    actor,
    summary: `Tasks cancelled — service ${sd.service_type} deactivated`,
  })
  if (taskResult.success && taskResult.outcome === "updated") {
    tasksCancelled = taskResult.count ?? 0
  }

  // Renewal types on an account: optionally clear the account date so the
  // nightly cron won't re-create the SD.
  let renewalDateCleared = false
  if (params.clear_renewal_date && sd.account_id && isRenewalServiceType(sd.service_type)) {
    const column = RENEWAL_DATE_COLUMN[sd.service_type]
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select(column)
      .eq("id", sd.account_id)
      .maybeSingle()
    const previousValue = (acct as Record<string, unknown> | null)?.[column] ?? null
    if (previousValue !== null) {
      const patch =
        column === "ra_renewal_date"
          ? { ra_renewal_date: null }
          : { annual_report_due_date: null }
      const acctResult = await updateAccount({
        id: sd.account_id,
        patch,
        actor,
        summary: `Cleared ${column} — ${sd.service_type} deactivated`,
        details: { cleared_column: column, previous_value: previousValue, reason: params.reason ?? null },
      })
      if (acctResult.success) renewalDateCleared = true
    }
  }

  logAction({
    actor,
    action_type: "update",
    table_name: "service_deliveries",
    record_id: sd.id,
    account_id: sd.account_id ?? undefined,
    contact_id: sd.contact_id ?? undefined,
    summary: `Service deactivated: ${sd.service_type}`,
    details: {
      reason: params.reason ?? null,
      tasks_cancelled: tasksCancelled,
      renewal_date_cleared: renewalDateCleared,
    },
  })

  return {
    success: true,
    outcome: "deactivated",
    delivery_id: sd.id,
    service_type: sd.service_type,
    tasks_cancelled: tasksCancelled,
    renewal_date_cleared: renewalDateCleared,
  }
}

export interface ReactivateSDParams {
  delivery_id: string
  actor?: string
  /** Optimistic-lock sentinel — observed SD.updated_at when the page rendered. */
  expected_updated_at?: string
}

export interface ReactivateSDResult {
  success: boolean
  outcome: "reactivated" | "not_cancelled" | "stale" | "not_found" | "conflict" | "error"
  delivery_id: string
  service_type?: string
  task_created?: boolean
  /**
   * True when the reactivated service is a renewal type whose account renewal
   * date is currently empty — the UI/tool should warn that the date must be
   * set on the account for the renewal to be managed again. We intentionally
   * do NOT auto-restore the date.
   */
  renewal_date_empty?: boolean
  error?: string
}

/**
 * Reactivate a cancelled service delivery (cancelled → active).
 *
 * Keeps the current stage so it resumes where it left off, clears end_date,
 * and creates one fresh tracked task (deactivate cancelled the old ones, so an
 * active SD would otherwise have nothing tracking it). Only acts on a
 * `cancelled` SD — a clean no-op otherwise (completed services are left
 * untouched; re-doing a finished service is a different intent).
 */
export async function reactivateSD(
  params: ReactivateSDParams,
): Promise<ReactivateSDResult> {
  const actor = params.actor || "system"

  const { data: sd, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("id, service_type, service_name, status, account_id, contact_id, updated_at")
    .eq("id", params.delivery_id)
    .maybeSingle()

  if (sdErr) {
    return { success: false, outcome: "error", delivery_id: params.delivery_id, error: sdErr.message }
  }
  if (!sd) {
    return { success: false, outcome: "not_found", delivery_id: params.delivery_id, error: "Service delivery not found" }
  }
  if (params.expected_updated_at && sd.updated_at !== params.expected_updated_at) {
    return {
      success: false,
      outcome: "stale",
      delivery_id: params.delivery_id,
      service_type: sd.service_type,
      error: "This service has been updated since you opened the page. Refresh and try again.",
    }
  }
  if (sd.status !== "cancelled") {
    return {
      success: false,
      outcome: "not_cancelled",
      delivery_id: params.delivery_id,
      service_type: sd.service_type,
      error: `Only cancelled services can be reactivated (current status: ${sd.status}).`,
    }
  }

  // Per-person services (ITIN): reactivating into a second live instance is
  // impossible — a person holds exactly one. Check it HERE and return a plain
  // message, because the DB backstop uq_itin_sd_active_per_contact would
  // otherwise raise 23505 inside dbWrite, which THROWS: the typed result
  // contract is bypassed and the CRM button dies silently with no toast.
  // Refusing is correct; refusing invisibly is not.
  if (sd.contact_id && (await isPerPersonServiceType(sd.service_type))) {
    // Predicate must match the LIFETIME rule the rest of the system enforces
    // (`status.is.null,status.neq.cancelled`), NOT the narrower `active`-only
    // scope of the DB index. The index is a race backstop; a person receives
    // exactly one ITIN in their life, so a `completed` / `on_hold` / NULL-status
    // one blocks a reactivation too — and the index would not catch it.
    const { data: liveSame, error: liveSameErr } = await supabaseAdmin
      .from("service_deliveries")
      .select("id")
      .eq("service_type", sd.service_type)
      .eq("contact_id", sd.contact_id)
      .or("status.is.null,status.neq.cancelled")
      .neq("id", sd.id)
      .limit(1)
    // Fail closed: an unverifiable check must not wave a reactivation through.
    if (liveSameErr) {
      return {
        success: false,
        outcome: "error",
        delivery_id: params.delivery_id,
        service_type: sd.service_type,
        error: `Could not verify whether this person already has a ${sd.service_type} (${liveSameErr.message}) — not reactivated.`,
      }
    }
    if (liveSame && liveSame.length > 0) {
      return {
        success: false,
        outcome: "conflict",
        delivery_id: params.delivery_id,
        service_type: sd.service_type,
        error: `This person already has a live ${sd.service_type} service — one person can only ever hold one. Cancel that one first if you meant to swap them.`,
      }
    }
  }

  let statusQuery = supabaseAdmin
    .from("service_deliveries")
    .update({ status: "active", end_date: null, updated_at: new Date().toISOString() })
    .eq("id", sd.id)
    .eq("status", "cancelled")
  if (params.expected_updated_at) {
    statusQuery = statusQuery.eq("updated_at", params.expected_updated_at)
  }
  // dbWriteSafe (not dbWrite): a unique-violation must come back as a value we
  // can turn into a message, never an exception that escapes the server action.
  const { data: updated, error: updateErr } = await dbWriteSafe(
    statusQuery.select("id").maybeSingle(),
    "service_deliveries.update.reactivate",
  )
  if (updateErr) {
    const isUnique = updateErr.includes("23505") || /duplicate key value/i.test(updateErr)
    return {
      success: false,
      outcome: isUnique ? "conflict" : "error",
      delivery_id: params.delivery_id,
      service_type: sd.service_type,
      error: isUnique
        ? `This person already has a live ${sd.service_type} service — one person can only ever hold one.`
        : updateErr,
    }
  }
  if (!updated) {
    return {
      success: false,
      outcome: "stale",
      delivery_id: params.delivery_id,
      service_type: sd.service_type,
      error: "This service was modified concurrently. Refresh and try again.",
    }
  }

  // Fresh tracked task so the reactivated SD isn't left with nothing tracking
  // it. Plain task (no workflow) — mirrors the universal-task fallback in
  // createSD. Fire-and-forget: task failure does NOT undo the reactivation.
  let taskCreated = false
  try {
    // eslint-disable-next-line no-restricted-syntax -- plain tracked-task for reactivated SD, mirrors createSD universal-task fallback
    const { error: taskErr } = await dbWriteSafe(
      supabaseAdmin.from("tasks").insert({
        task_title: `${sd.service_type} — ${sd.service_name || sd.service_type}`,
        description: `Service reactivated. Resume the lifecycle using the action buttons.`,
        assigned_to: defaultTaskAssignee(),
        priority: "Normal",
        status: "To Do",
        account_id: sd.account_id ?? undefined,
        contact_id: sd.contact_id ?? undefined,
        delivery_id: sd.id,
        created_by: "System",
        // tasks.attachments is NOT NULL with no DB default — always set it.
        attachments: [],
      }),
      "tasks.insert.reactivate-sd",
    )
    if (!taskErr) taskCreated = true
  } catch (err) {
    console.warn(
      `[reactivateSD] fresh-task creation failed (non-fatal) for SD ${sd.id} (${sd.service_type}):`,
      err instanceof Error ? err.message : String(err),
    )
  }

  // Renewal types: flag when the account date is empty so the caller can warn.
  let renewalDateEmpty = false
  if (sd.account_id && isRenewalServiceType(sd.service_type)) {
    const column = RENEWAL_DATE_COLUMN[sd.service_type]
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select(column)
      .eq("id", sd.account_id)
      .maybeSingle()
    const value = (acct as Record<string, unknown> | null)?.[column] ?? null
    if (value === null) renewalDateEmpty = true
  }

  logAction({
    actor,
    action_type: "update",
    table_name: "service_deliveries",
    record_id: sd.id,
    account_id: sd.account_id ?? undefined,
    contact_id: sd.contact_id ?? undefined,
    summary: `Service reactivated: ${sd.service_type}`,
    details: { task_created: taskCreated, renewal_date_empty: renewalDateEmpty },
  })

  return {
    success: true,
    outcome: "reactivated",
    delivery_id: sd.id,
    service_type: sd.service_type,
    task_created: taskCreated,
    renewal_date_empty: renewalDateEmpty,
  }
}

// ─── revertServiceDelivery ─────────────────────────────

export interface RevertStageParams {
  delivery_id: string
  actor?: string
  /** Free-text note appended to stage_history + action_log. */
  notes?: string
}

export interface RevertStageResult {
  success: boolean
  outcome: "reverted" | "at_first_stage" | "not_found" | "error"
  delivery_id: string
  service_type?: string
  from_stage?: string
  to_stage?: string
  to_order?: number
  /** Documents deleted (stamped with the target/previous stage). */
  documents_deleted?: number
  /** SD was at a completed final stage and was reset to active. */
  status_reset?: boolean
  /** Set when reverting OUT of a "Closed" renewal stage undid the +1y bump. */
  renewal_date_reverted?: { column: string; from: string; to: string } | null
  error?: string
}

/**
 * Untyped delete surface for the `documents` table. `flow_stage` was added by
 * the S0 flow-workspace migration but the generated DB types haven't been
 * regenerated (gen:types pending), so a typed `.match({ flow_stage })` won't
 * compile. We cast to a minimal local shape (NOT SupabaseClient — that cast is
 * eslint-blocked) so the query type-checks while staying on the real client.
 */
type UntypedDocDelete = {
  from: (table: string) => {
    delete: () => {
      match: (q: Record<string, unknown>) => {
        select: (
          cols: string,
        ) => PromiseLike<{ data: { id: string }[] | null; error: { message: string } | null }>
      }
    }
  }
}

/**
 * Revert a service delivery ONE stage backwards — the inverse of advancing.
 *
 * Backs the flow Workspace "← Go Back" button. Steps:
 *   1. Resolve current + previous stage by NAME from pipeline_stages (SD
 *      stage_order is frequently NULL/stale, so name is the reliable key).
 *   2. If there is no earlier stage, return `at_first_stage` (the button is
 *      hidden on the first stage, this is the server-side guard).
 *   3. Delete the documents stamped with the PREVIOUS (target) stage — these
 *      are the deliverables that completed the stage being re-opened (a doc
 *      uploaded while viewing stage B is stamped flow_stage=B and then
 *      auto-advances the SD to C; so going C→B removes the flow_stage=B docs so
 *      they can be re-uploaded). Internal docs (portal_visible=false) → hard
 *      delete is allowed (R100).
 *   4. Move the SD back: stage/stage_order/stage_entered_at + append a
 *      stage_history entry. If the SD was at a completed final stage
 *      (status='completed'), reset it to 'active' and clear end_date.
 *   5. If leaving a "Closed" renewal final (State Annual Report / State RA
 *      Renewal), undo advanceServiceDelivery's +1-year renewal-date bump by
 *      subtracting one year from the relevant account date.
 *
 * NOT undone (deliberate, documented limitations): tasks that advance
 * auto-closed on completion are NOT reopened; the underlying Drive/Storage file
 * is NOT deleted (only the documents row).
 */
export async function revertServiceDelivery(
  params: RevertStageParams,
): Promise<RevertStageResult> {
  const actor = params.actor || "system"

  // 1. Load SD.
  const { data: sd, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .select(
      "id, service_type, service_name, stage, status, account_id, contact_id, stage_history, end_date",
    )
    .eq("id", params.delivery_id)
    .maybeSingle()

  if (sdErr) {
    return { success: false, outcome: "error", delivery_id: params.delivery_id, error: sdErr.message }
  }
  if (!sd) {
    return { success: false, outcome: "not_found", delivery_id: params.delivery_id, error: "Service delivery not found" }
  }

  // 2. Resolve the pipeline + current/previous stage by name.
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
      service_type: sd.service_type,
      error: `No pipeline stages for service_type "${sd.service_type}"`,
    }
  }

  const current = stages.find((s) => s.stage_name === sd.stage)
  if (!current) {
    return {
      success: false,
      outcome: "error",
      delivery_id: sd.id,
      service_type: sd.service_type,
      error: `Current stage "${sd.stage}" is not part of the "${sd.service_type}" pipeline.`,
    }
  }

  const previous = stages
    .filter((s) => s.stage_order < current.stage_order)
    .sort((a, b) => b.stage_order - a.stage_order)[0]

  if (!previous) {
    return {
      success: false,
      outcome: "at_first_stage",
      delivery_id: sd.id,
      service_type: sd.service_type,
      error: "Already at the first stage — there is no previous step to go back to.",
    }
  }

  // 3. Delete documents stamped with the PREVIOUS (target) stage. documents is
  // not a protected table, so a raw delete is fine; flow_stage is untyped.
  let documentsDeleted = 0
  const adminDocs = supabaseAdmin as unknown as UntypedDocDelete
  const { data: deletedDocs, error: delErr } = await dbWriteSafe(
    adminDocs
      .from("documents")
      .delete()
      .match({ service_delivery_id: sd.id, flow_stage: previous.stage_name })
      .select("id"),
    "documents.delete.flow-revert",
  )
  if (!delErr && Array.isArray(deletedDocs)) documentsDeleted = deletedDocs.length

  // 4. Move the SD back. Append a stage_history entry mirroring the forward
  // shape so the audit trail reads symmetrically.
  const historyEntry = {
    from_stage: sd.stage || "New",
    from_order: current.stage_order,
    to_stage: previous.stage_name,
    to_order: previous.stage_order,
    advanced_at: new Date().toISOString(),
    advanced_by: actor,
    notes: params.notes || "Reverted to previous stage",
  }
  const stageHistory = Array.isArray(sd.stage_history)
    ? [...sd.stage_history, historyEntry]
    : [historyEntry]

  const patch: Record<string, unknown> = {
    stage: previous.stage_name,
    stage_order: previous.stage_order,
    stage_entered_at: new Date().toISOString(),
    stage_history: stageHistory,
    updated_at: new Date().toISOString(),
  }
  // Reverting out of a completed final stage re-opens the SD.
  const statusReset = sd.status === "completed"
  if (statusReset) {
    patch.status = "active"
    patch.end_date = null
  }

  await dbWrite(
    supabaseAdmin.from("service_deliveries").update(patch).eq("id", sd.id),
    "service_deliveries.update.revert",
  )

  // 5. Undo the +1-year renewal-date bump when leaving a "Closed" renewal final.
  let renewalDateReverted: { column: string; from: string; to: string } | null = null
  const leavingClosedRenewalFinal = sd.stage === "Closed" && isRenewalServiceType(sd.service_type)
  if (leavingClosedRenewalFinal && sd.account_id) {
    const column = RENEWAL_DATE_COLUMN[sd.service_type]
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select(column)
      .eq("id", sd.account_id)
      .maybeSingle()
    const currentValue = (acct as Record<string, unknown> | null)?.[column] as string | null | undefined
    if (currentValue) {
      const d = new Date(currentValue)
      d.setFullYear(d.getFullYear() - 1)
      const newValue = d.toISOString().split("T")[0]
      const acctPatch =
        column === "ra_renewal_date"
          ? { ra_renewal_date: newValue }
          : { annual_report_due_date: newValue }
      const acctResult = await updateAccount({
        id: sd.account_id,
        patch: acctPatch,
        actor,
        summary: `Reverted ${column} -1y — ${sd.service_type} reverted from Closed`,
        details: { column, from: currentValue, to: newValue },
      })
      if (acctResult.success) {
        renewalDateReverted = { column, from: currentValue, to: newValue }
      }
    }
  }

  logAction({
    actor,
    action_type: "update",
    table_name: "service_deliveries",
    record_id: sd.id,
    account_id: sd.account_id ?? undefined,
    contact_id: sd.contact_id ?? undefined,
    summary: `Stage reverted: ${sd.stage || "New"} → ${previous.stage_name} (${sd.service_name || sd.service_type})`,
    details: {
      from_stage: sd.stage,
      to_stage: previous.stage_name,
      documents_deleted: documentsDeleted,
      status_reset: statusReset,
      renewal_date_reverted: renewalDateReverted,
      notes: params.notes ?? null,
    },
  })

  return {
    success: true,
    outcome: "reverted",
    delivery_id: sd.id,
    service_type: sd.service_type,
    from_stage: sd.stage || "New",
    to_stage: previous.stage_name,
    to_order: previous.stage_order,
    documents_deleted: documentsDeleted,
    status_reset: statusReset,
    renewal_date_reverted: renewalDateReverted,
  }
}

/**
 * Persist the client-entered shipping info (courier + tracking number) for the
 * signed ITIN package mailed to the TD office (Client Signing stage). Centralised
 * here because service_deliveries is a protected table — raw `.update()` is only
 * allowed inside lib/operations/. Stamps `shipping_submitted_at = now()`.
 *
 * The caller (the portal API route) is responsible for authorization and for
 * validating the courier/tracking values before calling this.
 */
export async function setServiceDeliveryShipping(
  serviceDeliveryId: string,
  shipping: { courier: string; trackingNumber: string },
): Promise<void> {
  // shipping_* columns were added by 20260616-2300-itin-shipping-tracking.sql and
  // aren't in the generated DB types yet — Record<string, unknown> bypasses the
  // column-name check (same pattern as revertServiceDelivery's patch).
  const patch: Record<string, unknown> = {
    shipping_courier: shipping.courier,
    shipping_tracking_number: shipping.trackingNumber,
    shipping_submitted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  await dbWrite(
    supabaseAdmin.from("service_deliveries").update(patch).eq("id", serviceDeliveryId),
    "service_deliveries.update.shipping",
  )
}
