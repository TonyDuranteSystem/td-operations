/**
 * formation.confirm_ein_received — formation_progress action.
 *
 * Records the EIN received from IRS on the account, then advances the SD
 * stage from SS-4 Sent to IRS → EIN Received (the final stage of the 8-stage v2
 * pipeline). Formation is then closed via the separate "Mark Formation
 * Complete" action (sd.mark_complete), which spawns the RA Renewal + Annual
 * Report SDs.
 *
 * Reads admin's typed EIN from ctx.params.ein_number (per the action's
 * requires_input field).
 *
 * Why a service-specific handler instead of generic chain.update_account_field?
 * Two distinct writes (account.ein_number + SD stage advance) need to be
 * coordinated atomically-from-Luca's-view in one click. Splitting into two
 * actions would require Luca to click twice and risk leaving the account
 * updated but SD not advanced.
 *
 * Idempotency: if account.ein_number is already set to the submitted value,
 * the helper skips the update (logs as no-op). SD advance is gated by stage
 * (advanceStage accepts any source stage; guard is by SD status, not stage name).
 */

import { updateAccount } from "@/lib/operations/account"
import { advanceStage } from "@/lib/operations/service-delivery"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { HandlerContext, HandlerResult, SideEffect, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { formationConfirmEinReceivedParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

const TARGET_STAGE = "EIN Received"

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
        { kind: "sd.advance.preview", detail: `→ ${TARGET_STAGE}` },
      ],
      preview: { sd_stage_change: `→ ${TARGET_STAGE}` },
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

  // ── 2. Advance SD stage ──────────────────────────────────────────
  const advance = await advanceStage({
    delivery_id: ctx.task.delivery_id,
    target_stage: TARGET_STAGE,
    actor: `workflow:formation.confirm_ein_received:${ctx.actor.id}`,
    notes: `EIN ${ein} recorded; advancing to ${TARGET_STAGE}`,
  })
  if (!advance.success) {
    sideEffects.push({
      kind: "sd.advance.failed",
      detail: advance.error ?? "advanceStage returned success=false",
    })
    return {
      success: true, // EIN was written — don't fail the whole action
      side_effects: sideEffects,
      task_meta_patch: { ein_number: ein, sd_stage_advance_error: advance.error },
      result: { ein, sd_advanced: false },
    }
  }
  sideEffects.push({
    kind: "sd.stage_advanced",
    detail: `${advance.from_stage} → ${advance.to_stage}`,
    ref_id: ctx.task.delivery_id,
  })

  return {
    success: true,
    side_effects: sideEffects,
    task_meta_patch: {
      ein_number: ein,
      sd_stage: advance.to_stage,
      sd_stage_at_action: advance.to_stage,
    },
    result: {
      ein,
      previous_ein: previousEin,
      sd_advanced: true,
      sd_stage: advance.to_stage,
    },
  }
}
