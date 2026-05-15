/**
 * task.waiting_with_optional_message — Generic handler for "Waiting on Client"
 * style actions.
 *
 * Sets the task to a waiting state. Optionally sends a bilingual message to
 * the client via portal chat. The portal_messages insert path automatically
 * fires the client notification (R103, 1/2h throttled), so no manual email
 * follow-up is needed.
 *
 * If a message is provided but the task has no contact_id and no account_id
 * to address it to, the handler fails (better than silently dropping the
 * message). If no message is provided, the action is purely a status
 * change with no external side effect.
 *
 * Expected params shape:
 *   { client_message_en?: string, client_message_it?: string }
 *     - Either or both may be provided. Recipient language picks which renders.
 *     - If neither is set, the handler only flips status — no message sent.
 *
 * Side effect: portal_messages.insert (when a message is provided).
 * Rollback: soft-delete via deleted_at/deleted_by (per R100).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

// Hardcoded admin sender id (Antonio's auth user id), mirrored from
// lib/mcp/tools/portal.ts portal_chat_send. Centralization is a future cleanup.
const ADMIN_SENDER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

async function pickMessageForRecipient(
  contactId: string | null,
  fallbackEn: string,
  fallbackIt: string,
): Promise<string> {
  if (!contactId) return fallbackEn || fallbackIt
  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("language")
    .eq("id", contactId)
    .maybeSingle()
  const lang = contact?.language === "it" ? "it" : "en"
  return lang === "it" ? (fallbackIt || fallbackEn) : (fallbackEn || fallbackIt)
}

export const taskWaitingWithOptionalMessage: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as {
    client_message_en?: unknown
    client_message_it?: unknown
  }
  const en = typeof params.client_message_en === "string" ? params.client_message_en.trim() : ""
  const it = typeof params.client_message_it === "string" ? params.client_message_it.trim() : ""

  // No message → status-change only.
  if (!en && !it) {
    return {
      success: true,
      side_effects: [{ kind: "task.waiting", detail: "no client message" }],
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

  const messageBody = await pickMessageForRecipient(contactId, en, it)

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [{ kind: "portal_message.preview", detail: "Would send portal chat message" }],
      preview: { portal_message: messageBody },
    }
  }

  // Resolve recipient contact for the portal thread (mirrors portal_chat_send).
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
      message: messageBody,
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

  // Fire-and-forget notification + email (same pattern as portal_chat_send,
  // R103: 1 email per conversation per 2 hours).
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
        body: messageBody.slice(0, 100),
        link: "/portal/chat",
      })
      await notifyClientOfAdminMessage({
        account_id: accountId,
        contact_id: contactId,
        messagePreview: messageBody,
      })
    } catch (err) {
      console.warn("[task.waiting_with_optional_message] notification failed:", err)
    }
  })()

  // Rollback: soft-delete the message per R100. Preserves audit; hides body from client.
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
        detail: `Sent to ${resolvedContactId ?? accountId}`,
        ref_id: inserted.id,
        rollback,
      },
    ],
    task_meta_patch: {
      last_client_message_id: inserted.id,
      last_client_message_at: inserted.created_at,
    },
    result: { portal_message_id: inserted.id },
  }
}
