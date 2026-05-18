/**
 * chain.send_email — Send an email via the canonical lib/operations/email.ts
 * sendEmail() path (Gmail under the hood, with 7-day duplicate detection
 * keyed on recipient+subject).
 *
 * Rollback is NOT possible — emails cannot be unsent. The side_effect is
 * recorded without a rollback function; if a downstream chain step fails,
 * the dispatcher's rollback loop will skip this entry. Workflows that need
 * recall semantics (e.g. itin.recall_and_recorrect) implement their own
 * recall handler that soft-deletes the visible artifacts on the client side
 * (portal docs / messages) — the email staying delivered is acceptable.
 *
 * Expected params shape:
 *   {
 *     to: string,                      // recipient
 *     subject: string,
 *     body_html: string,
 *     body_text?: string,
 *     skip_duplicate_check?: boolean,  // for legitimate resends (recall+resend)
 *     drive_file_ids?: string[],       // Drive attachments
 *   }
 *
 * The handler links the email back to the task's account_id/contact_id when
 * present so the CRM tracking surface shows it on the client's record.
 */

import { sendEmail } from "@/lib/operations/email"
import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { chainSendEmailParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

export const chainSendEmail: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as {
    to?: unknown
    subject?: unknown
    body_html?: unknown
    body_text?: unknown
    skip_duplicate_check?: unknown
    drive_file_ids?: unknown
  }

  const to = typeof params.to === "string" ? params.to.trim() : ""
  const subject = typeof params.subject === "string" ? params.subject.trim() : ""
  const bodyHtml = typeof params.body_html === "string" ? params.body_html : ""
  const bodyText = typeof params.body_text === "string" ? params.body_text : undefined
  const skipDup = params.skip_duplicate_check === true
  const driveIds = Array.isArray(params.drive_file_ids)
    ? (params.drive_file_ids.filter((x) => typeof x === "string") as string[])
    : undefined

  if (!to || !subject || !bodyHtml) {
    return {
      success: false,
      error: {
        code: "MISSING_EMAIL_FIELDS",
        message: "chain.send_email requires 'to', 'subject', 'body_html'",
      },
      side_effects: [],
    }
  }

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [{ kind: "email.preview", detail: `Would email ${to}` }],
      preview: { email_html: bodyHtml },
    }
  }

  const result = await sendEmail({
    to,
    subject,
    body_html: bodyHtml,
    body_text: bodyText,
    drive_file_ids: driveIds,
    skip_duplicate_check: skipDup,
    account_id: ctx.task.account_id ?? undefined,
    contact_id: ctx.task.contact_id ?? undefined,
    tag: `workflow:${ctx.workflow.slug}`,
  })

  if (result.outcome === "duplicate_blocked") {
    return {
      success: false,
      error: {
        code: "EMAIL_DUPLICATE_BLOCKED",
        message: `Same subject already sent to ${to} within 7 days. Pass skip_duplicate_check=true to override.`,
      },
      side_effects: [],
    }
  }

  if (!result.success) {
    return {
      success: false,
      error: { code: "EMAIL_SEND_FAILED", message: result.error ?? "sendEmail returned success=false" },
      side_effects: [],
    }
  }

  // No rollback for sent email — see header.
  return {
    success: true,
    side_effects: [
      {
        kind: "email.sent",
        detail: `To ${to} — ${subject}`,
        ref_id: result.gmail_message_id ?? undefined,
      },
    ],
    task_meta_patch: {
      last_email_message_id: result.gmail_message_id ?? null,
      last_email_to: to,
      last_email_at: new Date().toISOString(),
    },
    result: {
      gmail_message_id: result.gmail_message_id,
      gmail_thread_id: result.gmail_thread_id,
      tracking_id: result.tracking_id,
    },
  }
}
