/**
 * itin.confirm_number_received — Service-specific handler for the
 * "ITIN number received" action on the itin_irs_processing workflow.
 *
 * The IRS mails back the ITIN. Operator types the number + (optionally)
 * pastes the Drive URL of the IRS letter. This handler:
 *   1. Validates the ITIN format (9 digits, starts with 9).
 *   2. Parses the Drive file ID from the IRS letter URL (if provided).
 *   3. Stamps contacts.itin_number + contacts.itin_issue_date via the
 *      audited updateContact helper.
 *   4. Carries forward the inputs in task_meta so the next workflow
 *      (itin_number_received → "Deliver ITIN to client") can reference
 *      them when composing the client-facing message.
 *
 * The catalog transition (defined in services.itin.metadata.workflow_chain)
 * handles spawning the next workflow + advancing the SD; this handler
 * just stamps state.
 *
 * Expected params shape (multi-field requires_input):
 *   itin_number          (required, validated to /^9\d{8}$/ stripped of dashes)
 *   itin_issue_date      (optional, ISO date; defaults to today)
 *   irs_letter_drive_url (optional, URL or bare Drive file ID)
 */

import { updateContact } from "@/lib/operations/contact"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { autoSaveDocument } from "@/lib/portal/auto-save-document"
import type { HandlerContext, HandlerResult, SideEffect, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { itinConfirmNumberReceivedParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

const ADMIN_SENDER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

function buildClientNotice(firstName: string, lang: "en" | "it"): string {
  if (lang === "it") {
    return `Ciao ${firstName}, abbiamo ricevuto il tuo numero ITIN dall'IRS. La lettera ufficiale è ora disponibile nel tuo portale, nella sezione Documenti.`
  }
  return `Hi ${firstName}, we received your ITIN number from the IRS. The official letter is now available in your portal under Documents.`
}

const ITIN_FORMAT = /^9\d{8}$/

function normalizeItin(raw: string): string {
  return raw.replace(/[^0-9]/g, "")
}

/**
 * Extract a Drive file ID from a Drive URL or accept a bare file ID.
 * Returns null on failure (so the handler can skip the letter side-effect).
 */
function parseDriveFileId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  // Bare file ID: alphanumeric + - and _, length ~25-50.
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed
  // URLs: /file/d/<ID>/, /folders/<ID>, ?id=<ID>
  const fileMatch = trimmed.match(/\/file\/d\/([A-Za-z0-9_-]{20,})/)
  if (fileMatch) return fileMatch[1]
  const folderMatch = trimmed.match(/\/folders\/([A-Za-z0-9_-]{20,})/)
  if (folderMatch) return folderMatch[1]
  const queryMatch = trimmed.match(/[?&]id=([A-Za-z0-9_-]{20,})/)
  if (queryMatch) return queryMatch[1]
  return null
}

export const itinConfirmNumberReceived: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as {
    itin_number?: unknown
    itin_issue_date?: unknown
    irs_letter_drive_url?: unknown
  }

  const rawItin = typeof params.itin_number === "string" ? params.itin_number.trim() : ""
  const normalized = normalizeItin(rawItin)
  if (!normalized) {
    return {
      success: false,
      error: { code: "MISSING_ITIN_NUMBER", message: "ITIN number is required" },
      side_effects: [],
    }
  }
  if (!ITIN_FORMAT.test(normalized)) {
    return {
      success: false,
      error: {
        code: "INVALID_ITIN_FORMAT",
        message: `ITIN must be 9 digits starting with 9 (got '${rawItin}' — normalized to '${normalized}')`,
      },
      side_effects: [],
    }
  }

  const rawIssueDate = typeof params.itin_issue_date === "string" ? params.itin_issue_date.trim() : ""
  const issueDate = rawIssueDate || new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    return {
      success: false,
      error: {
        code: "INVALID_ISSUE_DATE",
        message: `itin_issue_date must be ISO (YYYY-MM-DD), got '${rawIssueDate}'`,
      },
      side_effects: [],
    }
  }

  const rawLetterUrl =
    typeof params.irs_letter_drive_url === "string" ? params.irs_letter_drive_url.trim() : ""
  const letterFileId = rawLetterUrl ? parseDriveFileId(rawLetterUrl) : null

  const meta = ctx.task.task_meta as Record<string, unknown> | null
  const firstName =
    meta && typeof meta.client_first_name === "string" ? meta.client_first_name : "client"
  const lang =
    meta && (meta.client_language === "it" || meta.client_language === "en")
      ? (meta.client_language as "en" | "it")
      : "en"
  const clientNotice = buildClientNotice(firstName, lang)

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [
        {
          kind: "contact.field_preview",
          detail: `Would stamp contact.itin_number='${normalized}', itin_issue_date='${issueDate}'`,
        },
        ...(letterFileId
          ? [
              { kind: "documents.register_preview", detail: `Would register IRS letter as portal-visible document` },
              { kind: "task_meta.letter_preview", detail: `IRS letter Drive file ID: ${letterFileId}` },
            ]
          : []),
        { kind: "portal_message.preview", detail: `Would post bilingual (${lang}) notice to client` },
      ],
      preview: {
        portal_message: clientNotice,
      },
    }
  }

  // Resolve contact_id: prefer task.contact_id; for account-only tasks, look up
  // the primary contact. ITINs SHOULD be contact-linked per project rule, so this
  // is mostly belt-and-suspenders.
  if (!ctx.task.contact_id) {
    return {
      success: false,
      error: {
        code: "NO_CONTACT",
        message: "Task has no contact_id — cannot stamp the ITIN on the contact's CRM record",
      },
      side_effects: [],
    }
  }

  const update = await updateContact({
    id: ctx.task.contact_id,
    patch: {
      itin_number: normalized,
      itin_issue_date: issueDate,
      itin: normalized,
    } as Parameters<typeof updateContact>[0]["patch"],
    actor: "workflow:itin.confirm_number_received",
    summary: `Stamped ITIN ${normalized} on contact (issued ${issueDate})`,
    details: { itin_number: normalized, itin_issue_date: issueDate },
  })

  if (!update.success) {
    return {
      success: false,
      error: { code: "CONTACT_UPDATE_FAILED", message: update.error ?? "updateContact returned success=false" },
      side_effects: [],
    }
  }

  const sideEffects: SideEffect[] = [
    {
      kind: "contact.itin_stamped",
      detail: `contacts.itin_number = '${normalized}' (issued ${issueDate})`,
      ref_id: ctx.task.contact_id,
    },
  ]

  // ── Register the IRS letter as a portal-visible document ────────────
  // So the client sees it under their Documents tab. Skipped when no
  // letter file was uploaded. autoSaveDocument is idempotent on
  // (account_id, drive_file_id) so re-runs don't dupe rows.
  let documentRowId: string | null = null
  if (letterFileId) {
    const slug = `${(meta as Record<string, unknown> | null)?.client_first_name ?? ""}_${(meta as Record<string, unknown> | null)?.client_last_name ?? ""}`
      .replace(/\s+/g, "_")
      .replace(/^_|_$/g, "")
    const docName = slug ? `ITIN_Letter_${slug}.pdf` : `ITIN_Letter.pdf`
    const docResult = await autoSaveDocument({
      accountId: ctx.task.account_id ?? undefined,
      contactId: ctx.task.account_id ? undefined : ctx.task.contact_id,
      fileName: docName,
      documentType: "ITIN IRS Letter",
      category: 3,
      driveFileId: letterFileId,
      portalVisible: true,
    } as Parameters<typeof autoSaveDocument>[0])
    if (docResult.error) {
      console.warn("[itin.confirm_number_received] autoSaveDocument failed:", docResult.error)
    } else {
      documentRowId = docResult.id ?? null
      sideEffects.push({
        kind: "documents.portal_registered",
        detail: `IRS letter registered as portal-visible document`,
        ref_id: documentRowId ?? letterFileId,
      })
    }
  }

  // ── Post the client-facing notice in their language ─────────────────
  // Resolve recipient contact for the portal thread (mirrors portal_chat_send).
  let resolvedContactId = ctx.task.contact_id
  if (!resolvedContactId && ctx.task.account_id) {
    const { data: primary } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", ctx.task.account_id)
      .eq("is_primary", true)
      .maybeSingle()
    resolvedContactId = primary?.contact_id ?? null
  }

  const { data: portalMsg, error: portalErr } = await supabaseAdmin
    .from("portal_messages")
    .insert({
      account_id: ctx.task.account_id ?? null,
      contact_id: resolvedContactId,
      sender_type: "admin",
      sender_id: ADMIN_SENDER_ID,
      message: clientNotice,
      topic: ctx.workflow.auto_topic ?? "ITIN",
      attachments: [],
    })
    .select("id, created_at")
    .single()

  if (portalErr || !portalMsg) {
    // Non-fatal — the contact stamp + document register already succeeded.
    // Log loudly so ops sees the missed notification.
    console.warn("[itin.confirm_number_received] portal_messages insert failed:", portalErr?.message)
  } else {
    sideEffects.push({
      kind: "portal_message.sent",
      detail: `Bilingual (${lang}) ITIN-received notice posted to client`,
      ref_id: portalMsg.id,
      rollback: async () => {
        await supabaseAdmin
          .from("portal_messages")
          .update({ deleted_at: new Date().toISOString(), deleted_by: ctx.actor.id })
          .eq("id", portalMsg.id)
      },
    })

    // R103 notification + email (fire-and-forget, throttled).
    void (async () => {
      try {
        const { createPortalNotification, notifyClientOfAdminMessage } = await import(
          "@/lib/portal/notifications"
        )
        await createPortalNotification({
          account_id: ctx.task.account_id ?? undefined,
          contact_id: ctx.task.contact_id ?? undefined,
          type: "chat",
          title: "Your ITIN number is in your portal",
          body: clientNotice.slice(0, 100),
          link: "/portal/chat",
        })
        await notifyClientOfAdminMessage({
          account_id: ctx.task.account_id ?? null,
          contact_id: ctx.task.contact_id ?? null,
          messagePreview: clientNotice,
        })
      } catch (err) {
        console.warn("[itin.confirm_number_received] R103 notification failed:", err)
      }
    })()
  }

  if (letterFileId) {
    sideEffects.push({
      kind: "task_meta.letter_recorded",
      detail: `IRS letter Drive file ID stored in task_meta`,
      ref_id: letterFileId,
    })
  }

  return {
    success: true,
    side_effects: sideEffects,
    task_meta_patch: {
      itin_number: normalized,
      itin_issue_date: issueDate,
      ...(letterFileId ? { irs_letter_file_id: letterFileId, irs_letter_drive_url: rawLetterUrl } : {}),
      ...(documentRowId ? { portal_document_id: documentRowId } : {}),
      ...(portalMsg ? { client_notice_message_id: portalMsg.id } : {}),
    },
    result: {
      itin_number: normalized,
      itin_issue_date: issueDate,
      contact_id: ctx.task.contact_id,
      irs_letter_file_id: letterFileId,
      portal_document_id: documentRowId,
      client_notice_message_id: portalMsg?.id ?? null,
    },
  }
}
