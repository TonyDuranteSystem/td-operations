import { NextRequest, NextResponse } from "next/server"
import { sendEmail, renderEmailTemplate } from "@/lib/operations/email"

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
  // Template
  template_id?: string
  template_vars?: Record<string, unknown>
  skip_duplicate_check?: boolean
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
    const payload = (await req.json()) as ComposeRequest

    if (!payload.to) {
      return NextResponse.json({ error: "to is required" }, { status: 400 })
    }

    let subject = payload.subject || ""
    let body_html = payload.body_html
      ?? (payload.message ? plainToHtml(payload.message) : undefined)

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
      skip_duplicate_check: payload.skip_duplicate_check,
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
