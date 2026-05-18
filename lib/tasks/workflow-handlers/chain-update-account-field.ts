/**
 * chain.update_account_field — Set a single field on the parent task's
 * account (or an account identified by params).
 *
 * Mirrors chain.update_contact_field exactly, swapping the table.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { updateAccount } from "@/lib/operations/account"
import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { chainUpdateAccountFieldParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

export const chainUpdateAccountField: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as {
    value?: unknown
    account_id_override?: unknown
  }
  const handlerParams = (ctx.action.handler_params ?? {}) as {
    field?: unknown
    value?: unknown
  }

  const field = typeof handlerParams.field === "string" ? handlerParams.field.trim() : ""
  if (!field) {
    return {
      success: false,
      error: {
        code: "MISSING_FIELD",
        message: "chain.update_account_field requires action.handler_params.field",
      },
      side_effects: [],
    }
  }

  const FORBIDDEN_FIELDS = new Set([
    "id",
    "created_at",
    "updated_at",
    "portal_tier",
    "portal_account",
    "client_since",
  ])
  if (FORBIDDEN_FIELDS.has(field)) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN_FIELD",
        message: `chain.update_account_field cannot modify '${field}'`,
      },
      side_effects: [],
    }
  }

  const value = params.value !== undefined ? params.value : handlerParams.value
  if (value === undefined) {
    return {
      success: false,
      error: {
        code: "MISSING_VALUE",
        message: "chain.update_account_field requires 'value' in params or action.handler_params",
      },
      side_effects: [],
    }
  }

  const accountId =
    typeof params.account_id_override === "string"
      ? params.account_id_override
      : ctx.task.account_id
  if (!accountId) {
    return {
      success: false,
      error: {
        code: "NO_ACCOUNT",
        message:
          "chain.update_account_field needs an account — task.account_id is null and no account_id_override was supplied",
      },
      side_effects: [],
    }
  }

  const { data: before, error: readErr } = await supabaseAdmin
    .from("accounts")
    .select(field)
    .eq("id", accountId)
    .maybeSingle()
  if (readErr || !before) {
    return {
      success: false,
      error: { code: "ACCOUNT_NOT_FOUND", message: `Account ${accountId} not found` },
      side_effects: [],
    }
  }
  const previousValue = (before as unknown as Record<string, unknown>)[field]

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [
        { kind: "account.field_preview", detail: `${field}: ${String(previousValue)} → ${String(value)}` },
      ],
    }
  }

  const update = await updateAccount({
    id: accountId,
    patch: { [field]: value } as Parameters<typeof updateAccount>[0]["patch"],
    actor: "workflow-dispatcher",
    summary: `Workflow ${ctx.workflow.slug}/${ctx.action.slug} updated account.${field}`,
    details: { field, value, account_id: accountId },
  })

  if (!update.success) {
    return {
      success: false,
      error: { code: "ACCOUNT_UPDATE_FAILED", message: update.error ?? "updateAccount returned success=false" },
      side_effects: [],
    }
  }

  const rollback = async () => {
    await updateAccount({
      id: accountId,
      patch: { [field]: previousValue } as Parameters<typeof updateAccount>[0]["patch"],
      actor: "workflow-dispatcher-rollback",
      summary: `Rollback account.${field}`,
      details: { field, restored_value: previousValue, account_id: accountId },
    })
  }

  return {
    success: true,
    side_effects: [
      {
        kind: "account.field_updated",
        detail: `${field}: ${String(previousValue)} → ${String(value)}`,
        ref_id: accountId,
        rollback,
      },
    ],
    task_meta_patch: {
      [`account_${field}_previous`]: previousValue,
    },
    result: { account_id: accountId, field, previous_value: previousValue, new_value: value },
  }
}
