import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import { sendEmail, renderEmailTemplate, type SendEmailAttachment } from "@/lib/operations/email"
import {
  parseSignatureVariant,
  parseSignatureSender,
  SIGNATURE_MAILBOX_ADDRESSES,
} from "@/lib/email/signature"
import {
  parseStagedAttachmentInputs,
  loadStagedEmailAttachments,
  deleteStagedEmailAttachments,
  type StagedEmailAttachmentInput,
} from "@/lib/inbox/email-attachment-staging"

export const dynamic = "force-dynamic"

interface ComposeRequest {
  to: string
  subject?: string
  // Body — accept either HTML (preferred) or legacy `message` (plain text)
  body_html?: string
  message?: string
  cc?: string
  bcc?: string
  reply_to_message_id?: string
  // CRM linkage
  account_id?: string
  contact_id?: string
  lead_id?: string
  tag?: string
  // Tracking
  track_opens?: boolean
  // Attachments
  drive_file_ids?: string[]
  /** Staged uploads from the composer (paths minted by /api/inbox/attachments/upload-url). */
  attachments?: Array<{ path: string; name: string; mime_type?: string }>
  // Template
  template_id?: string
  template_vars?: Record<string, unknown>
  skip_duplicate_check?: boolean
  /**
   * When true (default from the compose UI), the body is wrapped with the
   * TD-branded shell (logo + footer). Plain-text bodies are auto-paragraphed.
   */
  wrap_with_brand?: boolean
  /**
   * Which mailbox to send from: "support" (shared, the default) or "antonio"
   * (his personal one, admin-only). Before this existed every new email left
   * from one fixed mailbox with no per-email choice.
   */
  mailbox?: string
  /** Which signature the sender picked: "gala" | "hat" | "text". */
  signature_variant?: string
}

function plainToHtml(text: string): string {
  // Escape < > & and wrap paragraphs. Simple transform that preserves the
  // text the admin typed in a textarea without needing a rich editor.
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  const paragraphs = escaped.split(/\n{2,}/).map((p) => p.replace(/\n/g, "<br />"))
  return paragraphs.map((p) => `<p>${p}</p>`).join("\n")
}

export async function POST(req: NextRequest) {
  try {
    // Staff gate — middleware only guarantees "is logged in" for /api routes,
    // and a portal CLIENT has a login. Sends branded mail as support@; the
    // 2026-07-21 invariant applies (council 2026-07-29).
    const denied = await requireStaffRoute()
    if (denied) return denied

    const payload = (await req.json()) as ComposeRequest

    if (!payload.to) {
      return NextResponse.json({ error: "to is required" }, { status: 400 })
    }

    // Sending mailbox. antonio@ is his PERSONAL mailbox and is admin-only —
    // the same server-side gate the reply route uses, because hiding the
    // control in the UI is not a security boundary.
    const senderKey = parseSignatureSender(payload.mailbox)
    if (!(await checkMailboxAccess(payload.mailbox))) {
      return NextResponse.json(
        { error: "Not authorized for this mailbox" },
        { status: 403 }
      )
    }

    // Staged file attachments — validate + load up front so a missing or
    // oversized file fails the send before anything goes out.
    let stagedInputs: StagedEmailAttachmentInput[] | null = null
    let attachments: SendEmailAttachment[] | undefined
    try {
      stagedInputs = parseStagedAttachmentInputs(payload.attachments)
      if (stagedInputs) attachments = await loadStagedEmailAttachments(stagedInputs)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Could not read an attachment." },
        { status: 400 }
      )
    }

    let subject = payload.subject || ""
    // When wrap_with_brand is on (UI default), pass the raw text through —
    // sendEmail's paragraph converter + shell handles it. When off, fall back
    // to the legacy plainToHtml wrapper for callers that send a message field.
    const wrap = payload.wrap_with_brand !== false
    let body_html = payload.body_html
      ?? (payload.message
        ? (wrap ? payload.message : plainToHtml(payload.message))
        : undefined)

    // If a template is referenced, render it (variables come from payload)
    if (payload.template_id) {
      const rendered = await renderEmailTemplate(
        payload.template_id,
        payload.template_vars
      )
      if (!rendered) {
        return NextResponse.json(
          { error: `Template ${payload.template_id} not found or inactive` },
          { status: 400 }
        )
      }
      subject = subject || rendered.subject
      body_html = body_html || rendered.body_html
    }

    if (!subject || !body_html) {
      return NextResponse.json(
        { error: "subject and body are required (or a valid template_id)" },
        { status: 400 }
      )
    }

    const result = await sendEmail({
      to: payload.to,
      subject,
      body_html,
      cc: payload.cc,
      bcc: payload.bcc,
      reply_to_message_id: payload.reply_to_message_id,
      track_opens: payload.track_opens,
      account_id: payload.account_id,
      contact_id: payload.contact_id,
      lead_id: payload.lead_id,
      tag: payload.tag,
      drive_file_ids: payload.drive_file_ids,
      attachments,
      skip_duplicate_check: payload.skip_duplicate_check,
      wrap_with_brand: wrap,
      // Only PIN the address when the sender explicitly picked the personal
      // mailbox. Leaving it undefined for "support" preserves the existing
      // fallback (GOOGLE_IMPERSONATE_EMAIL, then support@) — hardcoding the
      // literal here would silently move every outgoing email if that
      // variable is set to something else on a deployment.
      ...(senderKey === "antonio"
        ? { as_user: SIGNATURE_MAILBOX_ADDRESSES.antonio }
        : {}),
      signature_variant: parseSignatureVariant(payload.signature_variant),
    })

    if (result.outcome === "duplicate_blocked") {
      return NextResponse.json(
        {
          error: "Duplicate blocked",
          duplicate: result.duplicate,
        },
        { status: 409 }
      )
    }

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Send failed" },
        { status: 500 }
      )
    }

    // Send succeeded — clear the staged objects (best-effort; a failed send
    // above keeps them so a retry with the same paths still works).
    if (stagedInputs) {
      await deleteStagedEmailAttachments(stagedInputs.map((a) => a.path))
    }

    return NextResponse.json({
      success: true,
      messageId: result.gmail_message_id,
      threadId: result.gmail_thread_id,
      trackingId: result.tracking_id,
      attachmentCount: result.attachment_count,
      leadAutoUpdated: result.lead_auto_updated,
    })
  } catch (error) {
    console.error("Compose email error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send email" },
      { status: 500 }
    )
  }
}
