/**
 * chain.send_client_message — Send a bilingual portal-chat message to the
 * client and stamp the task with the message id.
 *
 * Same wire pattern as task.waiting_with_optional_message but message is
 * REQUIRED (not optional). Used by chain steps that always need to update
 * the client (e.g. "Forms are ready — sign and mail").
 *
 * Expected params shape (any subset of {en, it} permitted, at least one required):
 *   { body_en?: string, body_it?: string, topic?: string }
 *
 * Side effect: portal_messages.insert. Rollback: soft-delete (R100).
 * Notification + email fire automatically via R103 throttle.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { chainSendClientMessageParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

const ADMIN_SENDER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

async function pickLanguage(contactId: string | null): Promise<"en" | "it"> {
  if (!contactId) return "en"
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("language")
    .eq("id", contactId)
    .maybeSingle()
  return data?.language === "it" ? "it" : "en"
}

export const chainSendClientMessage: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  // Catalog handler_params supply pre-baked defaults; runtime params (operator
  // input via requires_input modal) override them. This lets catalog-driven
  // actions send without any operator input while still allowing customisation.
  const catalog = (ctx.action.handler_params ?? {}) as {
    body_en?: unknown
    body_it?: unknown
    topic?: unknown
  }
  const runtime = (ctx.params ?? {}) as {
    body_en?: unknown
    body_it?: unknown
    topic?: unknown
  }
  const pick = (r: unknown, c: unknown) =>
    (typeof r === "string" && r.trim() ? r.trim() : typeof c === "string" ? c.trim() : "")
  const en = pick(runtime.body_en, catalog.body_en)
  const it = pick(runtime.body_it, catalog.body_it)
  const topicRaw = runtime.topic ?? catalog.topic
  const topic = typeof topicRaw === "string" ? topicRaw.trim() : ctx.workflow.auto_topic

  if (!en && !it) {
    return {
      success: false,
      error: {
        code: "MISSING_MESSAGE",
        message: "chain.send_client_message requires at least one of body_en or body_it",
      },
      side_effects: [],
    }
  }

  const accountId = ctx.task.account_id ?? null
  const contactId = ctx.task.contact_id ?? null
  if (!accountId && !contactId) {
    return {
      success: false,
      error: {
        code: "NO_RECIPIENT",
        message: "Task has neither account_id nor contact_id — cannot send a client message",
      },
      side_effects: [],
    }
  }

  const lang = await pickLanguage(contactId)
  const body = (lang === "it" ? (it || en) : (en || it)).trim()

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [{ kind: "portal_message.preview", detail: "Would send portal chat message" }],
      preview: { portal_message: body },
    }
  }

  // Resolve recipient contact for the portal thread.
  let resolvedContactId = contactId
  if (!resolvedContactId && accountId) {
    const { data: primary } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", accountId)
      .eq("is_primary", true)
      .maybeSingle()
    resolvedContactId = primary?.contact_id ?? null
  }

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("portal_messages")
    .insert({
      account_id: accountId,
      contact_id: resolvedContactId,
      sender_type: "admin",
      sender_id: ADMIN_SENDER_ID,
      message: body,
      topic: topic ?? null,
      attachments: [],
    })
    .select("id, created_at")
    .single()

  if (insertErr || !inserted) {
    return {
      success: false,
      error: {
        code: "PORTAL_MESSAGE_INSERT_FAILED",
        message: insertErr?.message ?? "portal_messages.insert returned no row",
      },
      side_effects: [],
    }
  }

  void (async () => {
    try {
      const { createPortalNotification, notifyClientOfAdminMessage } = await import(
        "@/lib/portal/notifications"
      )
      await createPortalNotification({
        account_id: accountId ?? undefined,
        contact_id: contactId ?? undefined,
        type: "chat",
        title: "New message from Tony Durante Team",
        body: body.slice(0, 100),
        link: "/portal/chat",
      })
      await notifyClientOfAdminMessage({
        account_id: accountId,
        contact_id: contactId,
        messagePreview: body,
      })
    } catch (err) {
      console.warn("[chain.send_client_message] notification failed:", err)
    }
  })()

  const rollback = async () => {
    await supabaseAdmin
      .from("portal_messages")
      .update({ deleted_at: new Date().toISOString(), deleted_by: ctx.actor.id })
      .eq("id", inserted.id)
  }

  return {
    success: true,
    side_effects: [
      {
        kind: "portal_message.sent",
        detail: `Sent (${lang}) to ${resolvedContactId ?? accountId}`,
        ref_id: inserted.id,
        rollback,
      },
    ],
    task_meta_patch: {
      last_client_message_id: inserted.id,
      last_client_message_at: inserted.created_at,
    },
    result: { portal_message_id: inserted.id, language_sent: lang },
  }
}
