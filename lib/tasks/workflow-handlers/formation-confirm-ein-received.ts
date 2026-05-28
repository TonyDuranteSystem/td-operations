/**
 * formation.confirm_ein_received — formation_progress action.
 *
 * FLEXIBLE FORMATION MODEL (Antonio 2026-05-28): the EIN is the TERMINAL event
 * of formation. Recording it (1) writes accounts.ein_number, (2) marks the
 * Company Formation SD COMPLETE in place (no stage advance → no banking/lease/
 * welcome side-effects), and (3) flips the tier to active. Banking is portal
 * self-service, OA is self-service, the lease is a separate staff action —
 * none are auto-created here.
 *
 * Reads admin's typed EIN from ctx.params.ein_number (per the action's
 * requires_input field).
 *
 * Why a service-specific handler instead of generic chain.update_account_field?
 * Three writes (account.ein_number + SD completion + tier→active) need to be
 * coordinated in one Luca click. Splitting them would require multiple clicks
 * and risk leaving the account updated but the SD/tier not advanced.
 *
 * Idempotency: if account.ein_number is already set to the submitted value,
 * the EIN write is skipped (no-op). markServiceComplete no-ops if the SD is
 * already completed, and syncTier no-ops if already active. The old exact-stage
 * gate is GONE — EIN can be recorded based on facts, from any active stage.
 */

import { updateAccount } from "@/lib/operations/account"
import { markServiceComplete } from "@/lib/operations/service-delivery"
import { syncTier } from "@/lib/operations/sync-tier"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { HandlerContext, HandlerResult, SideEffect, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { formationConfirmEinReceivedParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

function normalizeEin(raw: string): string {
  // Strip everything except digits, then re-format as XX-XXXXXXX.
  const digits = raw.replace(/\D/g, "")
  if (digits.length !== 9) return raw.trim()
  return `${digits.slice(0, 2)}-${digits.slice(2)}`
}

export const formationConfirmEinReceived: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as { ein_number?: unknown }
  const rawEin = typeof params.ein_number === "string" ? params.ein_number.trim() : ""
  if (!rawEin) {
    return {
      success: false,
      error: {
        code: "MISSING_EIN",
        message: "formation.confirm_ein_received requires ein_number in params (from requires_input)",
      },
      side_effects: [],
    }
  }
  const ein = normalizeEin(rawEin)

  if (!ctx.task.account_id) {
    return {
      success: false,
      error: {
        code: "NO_ACCOUNT",
        message: "formation.confirm_ein_received requires task.account_id (account must exist before EIN can be recorded)",
      },
      side_effects: [],
    }
  }
  if (!ctx.task.delivery_id) {
    return {
      success: false,
      error: {
        code: "NO_DELIVERY",
        message: "formation.confirm_ein_received requires task.delivery_id (linked Company Formation SD)",
      },
      side_effects: [],
    }
  }

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [
        { kind: "account.field_preview", detail: `accounts.ein_number → ${ein}` },
        { kind: "sd.complete.preview", detail: `Company Formation → completed (formation ends at EIN)` },
        { kind: "tier.preview", detail: `portal_tier → active` },
      ],
      preview: { sd_stage_change: `Formation complete → Active` },
    }
  }

  // ── 1. Update accounts.ein_number ─────────────────────────────────
  // Read current value first to detect no-op + enable rollback.
  const { data: before } = await supabaseAdmin
    .from("accounts")
    .select("ein_number")
    .eq("id", ctx.task.account_id)
    .maybeSingle()
  const previousEin = before?.ein_number ?? null

  const sideEffects: SideEffect[] = []
  if (previousEin === ein) {
    sideEffects.push({
      kind: "account.field_no_op",
      detail: `accounts.ein_number already ${ein} — skipping write`,
    })
  } else {
    const update = await updateAccount({
      id: ctx.task.account_id,
      patch: { ein_number: ein } as Parameters<typeof updateAccount>[0]["patch"],
      actor: `workflow:formation.confirm_ein_received:${ctx.actor.id}`,
      summary: `Workflow formation_progress: EIN received ${ein}`,
      details: { field: "ein_number", previous_value: previousEin, new_value: ein },
    })
    if (!update.success) {
      return {
        success: false,
        error: { code: "ACCOUNT_UPDATE_FAILED", message: update.error ?? "updateAccount returned success=false" },
        side_effects: [],
      }
    }
    sideEffects.push({
      kind: "account.field_updated",
      detail: `accounts.ein_number: ${previousEin ?? "(null)"} → ${ein}`,
      ref_id: ctx.task.account_id,
      rollback: async () => {
        await updateAccount({
          id: ctx.task.account_id as string,
          patch: { ein_number: previousEin } as Parameters<typeof updateAccount>[0]["patch"],
          actor: "workflow:formation.confirm_ein_received:rollback",
          summary: `Rollback accounts.ein_number to ${previousEin ?? "(null)"}`,
          details: { field: "ein_number", restored_value: previousEin },
        })
      },
    })
  }

  // ── 2. Complete the Company Formation SD IN PLACE ────────────────
  // Formation ENDS at EIN. No stage advance → no banking/lease/welcome
  // side-effects. The old exact-stage gate is gone: markServiceComplete
  // completes from any active status, so EIN can be recorded based on facts.
  const done = await markServiceComplete({
    delivery_id: ctx.task.delivery_id,
    actor: `workflow:formation.confirm_ein_received:${ctx.actor.id}`,
    reason: `EIN ${ein} recorded — formation complete`,
  })
  if (!done.success) {
    sideEffects.push({
      kind: "sd.complete.failed",
      detail: done.error ?? "markServiceComplete returned success=false",
    })
    return {
      success: true, // EIN was written — don't fail the whole action
      side_effects: sideEffects,
      task_meta_patch: { ein_number: ein, sd_complete_error: done.error },
      result: { ein, sd_completed: false },
    }
  }
  sideEffects.push({
    kind: "sd.completed",
    detail: `Company Formation → completed (${done.outcome})`,
    ref_id: ctx.task.delivery_id,
  })

  // ── 3. Flip tier to active (formation complete = company active) ──
  const tier = await syncTier({
    accountId: ctx.task.account_id,
    newTier: "active",
    reason: `EIN ${ein} received — formation complete`,
    actor: `workflow:formation.confirm_ein_received:${ctx.actor.id}`,
  })
  sideEffects.push(
    tier.success
      ? { kind: "tier.synced", detail: `portal_tier → active`, ref_id: ctx.task.account_id }
      : { kind: "tier.sync_failed", detail: tier.error ?? "syncTier returned success=false" },
  )

  return {
    success: true,
    side_effects: sideEffects,
    task_meta_patch: {
      ein_number: ein,
      sd_completed: true,
      sd_stage: "Completed",
      sd_stage_at_action: "Completed",
    },
    result: {
      ein,
      previous_ein: previousEin,
      sd_completed: true,
      tier_synced: tier.success,
    },
  }
}
