/**
 * chain.update_contact_field — Set a single field on the parent task's
 * contact (or a contact identified by params).
 *
 * Uses the canonical updateContact helper (action_log audited, optimistic
 * lock available). Rollback restores the previous value if a later chain
 * step fails.
 *
 * The catalog row's handler_params declares the field name (so workflows
 * lock down WHICH field is touched at design time); the value comes from
 * the operator's requires_input. Both static-value and dynamic-value paths
 * are supported:
 *   handler_params: { field: 'language' }                 ← required
 *   params: { value: 'it' }                                ← runtime input
 *   OR
 *   handler_params: { field: 'preferred_language', value: 'en' } ← fully static
 *
 * Optional contact_id_override in params lets the action target a contact
 * other than task.contact_id (e.g. a member of an MMLLC distinct from the
 * task's primary contact).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { updateContact } from "@/lib/operations/contact"
import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

export const chainUpdateContactField: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as {
    value?: unknown
    contact_id_override?: unknown
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
        message: "chain.update_contact_field requires action.handler_params.field",
      },
      side_effects: [],
    }
  }

  // Allowlist: never let a workflow rewrite identity / linkage / audit
  // columns. Add to this list with caution.
  const FORBIDDEN_FIELDS = new Set([
    "id",
    "created_at",
    "updated_at",
    "portal_tier",
    "portal_email",
    "auth_user_id",
  ])
  if (FORBIDDEN_FIELDS.has(field)) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN_FIELD",
        message: `chain.update_contact_field cannot modify '${field}'`,
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
        message: "chain.update_contact_field requires 'value' in params or action.handler_params",
      },
      side_effects: [],
    }
  }

  const contactId =
    typeof params.contact_id_override === "string"
      ? params.contact_id_override
      : ctx.task.contact_id
  if (!contactId) {
    return {
      success: false,
      error: {
        code: "NO_CONTACT",
        message:
          "chain.update_contact_field needs a contact — task.contact_id is null and no contact_id_override was supplied",
      },
      side_effects: [],
    }
  }

  // Capture previous value for rollback.
  const { data: before, error: readErr } = await supabaseAdmin
    .from("contacts")
    .select(field)
    .eq("id", contactId)
    .maybeSingle()
  if (readErr || !before) {
    return {
      success: false,
      error: { code: "CONTACT_NOT_FOUND", message: `Contact ${contactId} not found` },
      side_effects: [],
    }
  }
  const previousValue = (before as unknown as Record<string, unknown>)[field]

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [
        { kind: "contact.field_preview", detail: `${field}: ${String(previousValue)} → ${String(value)}` },
      ],
    }
  }

  const update = await updateContact({
    id: contactId,
    patch: { [field]: value } as Parameters<typeof updateContact>[0]["patch"],
    actor: "workflow-dispatcher",
    summary: `Workflow ${ctx.workflow.slug}/${ctx.action.slug} updated contact.${field}`,
    details: { field, value, contact_id: contactId },
  })

  if (!update.success) {
    return {
      success: false,
      error: { code: "CONTACT_UPDATE_FAILED", message: update.error ?? "updateContact returned success=false" },
      side_effects: [],
    }
  }

  const rollback = async () => {
    await updateContact({
      id: contactId,
      patch: { [field]: previousValue } as Parameters<typeof updateContact>[0]["patch"],
      actor: "workflow-dispatcher-rollback",
      summary: `Rollback contact.${field}`,
      details: { field, restored_value: previousValue, contact_id: contactId },
    })
  }

  return {
    success: true,
    side_effects: [
      {
        kind: "contact.field_updated",
        detail: `${field}: ${String(previousValue)} → ${String(value)}`,
        ref_id: contactId,
        rollback,
      },
    ],
    task_meta_patch: {
      [`contact_${field}_previous`]: previousValue,
    },
    result: { contact_id: contactId, field, previous_value: previousValue, new_value: value },
  }
}
