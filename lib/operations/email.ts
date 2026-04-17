/**
 * P3.4 #5 — Email operation authority layer
 *
 * Single-entry send path used by:
 *   - MCP gmail_send tool (lib/mcp/tools/gmail.ts)
 *   - CRM compose dialog API route (app/api/inbox/compose/route.ts)
 *   - Future: dedicated send tools (offer_send, lease_send, ...) via
 *     P3.3 follow-up (dev_task 98484283).
 *
 * Handles: template rendering, ASCII sanitization, RFC 2047 subject encoding,
 * MIME multipart building, tracking pixel injection, Drive attachment download,
 * threading, duplicate detection, email_tracking insert, action_log insert,
 * lead-status auto-flip when tag='offer'.
 */

import { gmailPost, gmailGet, getHeader, type GmailAPIMessage } from "@/lib/gmail"
import { logAction } from "@/lib/mcp/action-log"
import { APP_BASE_URL } from "@/lib/config"
import { supabaseAdmin } from "@/lib/supabase-admin"

// ─── ASCII sanitizer ────────────────────────────────────────

export function sanitizeToAscii(text: string): string {
  return text
    .replace(/\u2014/g, "--")
    .replace(/\u2013/g, "-")
    .replace(/\u2018/g, "'")
    .replace(/\u2019/g, "'")
    .replace(/\u201C/g, '"')
    .replace(/\u201D/g, '"')
    .replace(/\u2022/g, "*")
    .replace(/\u2026/g, "...")
    .replace(/\u2192/g, "->")
    .replace(/\u2190/g, "<-")
    .replace(/\u2194/g, "<->")
    .replace(/\u00AB/g, "<<")
    .replace(/\u00BB/g, ">>")
}

// ─── Types ──────────────────────────────────────────────────

export interface SendEmailAttachment {
  filename: string
  content: string
  content_type?: string
}

export interface SendEmailParams {
  to: string
  subject: string
  body_html: string
  body_text?: string
  cc?: string
  bcc?: string
  reply_to?: string
  reply_to_message_id?: string
  as_user?: string
  track_opens?: boolean
  account_id?: string
  contact_id?: string
  lead_id?: string
  tag?: string
  drive_file_ids?: string[]
  attachments?: SendEmailAttachment[]
  skip_duplicate_check?: boolean
}

export interface SendEmailResult {
  success: boolean
  outcome: "sent" | "duplicate_blocked" | "error"
  gmail_message_id?: string
  gmail_thread_id?: string
  tracking_id?: string | null
  has_attachments: boolean
  attachment_count: number
  attachment_filenames?: string[]
  duplicate?: { sent_at: string; gmail_message_id: string | null }
  lead_auto_updated?: boolean
  error?: string
}

export interface RenderTemplateResult {
  subject: string
  body_html: string
  language: string | null
  template_name: string
}

// ─── Template rendering ─────────────────────────────────────

function substitutePlaceholders(
  input: string,
  vars: Record<string, unknown>
): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const value = vars[key]
    if (value === null || value === undefined) return match
    return String(value)
  })
}

export async function renderEmailTemplate(
  template_id: string,
  vars?: Record<string, unknown>
): Promise<RenderTemplateResult | null> {
  const { data, error } = await supabaseAdmin
    .from("email_templates")
    .select("template_name, subject_template, body_template, language, active")
    .eq("id", template_id)
    .maybeSingle()

  if (error || !data) return null
  if (data.active === false) return null

  const v = vars || {}
  return {
    subject: substitutePlaceholders(data.subject_template || "", v),
    body_html: substitutePlaceholders(data.body_template || "", v),
    language: data.language ?? null,
    template_name: data.template_name ?? "",
  }
}

// ─── sendEmail ──────────────────────────────────────────────

const DEFAULT_EMAIL = () =>
  process.env.GOOGLE_IMPERSONATE_EMAIL || "support@tonydurante.us"

export async function sendEmail(
  params: SendEmailParams
): Promise<SendEmailResult> {
  try {
    const subject = sanitizeToAscii(params.subject)
    const body_html = sanitizeToAscii(params.body_html)
    const body_text = params.body_text ? sanitizeToAscii(params.body_text) : undefined

    const fromEmail = params.as_user || DEFAULT_EMAIL()
    const track_opens = params.track_opens !== false

    // Download Drive attachments + merge with inline attachments
    const allAttachments: SendEmailAttachment[] = [...(params.attachments || [])]
    const driveIds = params.drive_file_ids || []
    if (driveIds.length > 0) {
      const { downloadFileBinary } = await import("@/lib/google-drive")
      for (const fileId of driveIds) {
        const { buffer, mimeType, fileName } = await downloadFileBinary(fileId)
        allAttachments.push({
          filename: fileName,
          content: buffer.toString("base64"),
          content_type: mimeType || "application/octet-stream",
        })
      }
    }

    // Tracking ID + pixel
    const trackingId = track_opens
      ? `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      : null

    let htmlBody = body_html
    if (track_opens && trackingId) {
      const pixelUrl = `${APP_BASE_URL}/api/track/open/${trackingId}`
      const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`
      if (htmlBody.includes("</body>")) {
        htmlBody = htmlBody.replace("</body>", `${pixel}</body>`)
      } else {
        htmlBody += pixel
      }
    }

    // Plain text fallback derived from HTML when not provided
    const plainText = body_text || htmlBody
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<li>/gi, "* ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, "\n\n")
      .trim()

    // Duplicate detection — skipped for replies and when explicitly requested
    if (!params.reply_to_message_id && !params.skip_duplicate_check) {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const { data: existing } = await supabaseAdmin
        .from("email_tracking")
        .select("id, created_at, gmail_message_id")
        .eq("recipient", params.to)
        .eq("subject", subject)
        .gte("created_at", cutoff)
        .limit(1)

      if (existing && existing.length > 0) {
        return {
          success: false,
          outcome: "duplicate_blocked",
          has_attachments: allAttachments.length > 0,
          attachment_count: allAttachments.length,
          duplicate: {
            sent_at: existing[0].created_at,
            gmail_message_id: existing[0].gmail_message_id,
          },
        }
      }
    }

    // MIME build
    const hasAttachments = allAttachments.length > 0
    const outerBoundary = `boundary_${Date.now()}`
    const altBoundary = `alt_boundary_${Date.now()}`

    const hasNonAscii = /[^\x00-\x7F]/.test(subject)
    const encodedSubject = hasNonAscii
      ? `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`
      : subject

    const mimeHeaders = [
      `From: Tony Durante LLC <${fromEmail}>`,
      `To: ${params.to}`,
      `Subject: ${encodedSubject}`,
    ]
    if (params.cc) mimeHeaders.push(`Cc: ${params.cc}`)
    if (params.bcc) mimeHeaders.push(`Bcc: ${params.bcc}`)
    if (params.reply_to) mimeHeaders.push(`Reply-To: ${params.reply_to}`)
    mimeHeaders.push("MIME-Version: 1.0")
    mimeHeaders.push(
      hasAttachments
        ? `Content-Type: multipart/mixed; boundary="${outerBoundary}"`
        : `Content-Type: multipart/alternative; boundary="${outerBoundary}"`
    )

    // Threading headers
    let threadId: string | undefined
    if (params.reply_to_message_id) {
      const original = (await gmailGet(
        `/messages/${params.reply_to_message_id}`,
        { format: "metadata", metadataHeaders: "Message-ID,References" },
        params.as_user
      )) as GmailAPIMessage
      const originalMsgId = getHeader(original.payload.headers, "Message-ID")
      const references = getHeader(original.payload.headers, "References")
      if (originalMsgId) {
        mimeHeaders.push(`In-Reply-To: ${originalMsgId}`)
        mimeHeaders.push(
          `References: ${references ? references + " " : ""}${originalMsgId}`
        )
      }
      threadId = original.threadId
    }

    if (params.tag) mimeHeaders.push(`X-Tag: ${params.tag}`)

    const mimeParts: string[] = [mimeHeaders.join("\r\n"), ""]

    if (hasAttachments) {
      mimeParts.push(`--${outerBoundary}`)
      mimeParts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`)
      mimeParts.push("")
      mimeParts.push(`--${altBoundary}`)
      mimeParts.push("Content-Type: text/plain; charset=utf-8")
      mimeParts.push("Content-Transfer-Encoding: base64")
      mimeParts.push("")
      mimeParts.push(Buffer.from(plainText).toString("base64"))
      mimeParts.push("")
      mimeParts.push(`--${altBoundary}`)
      mimeParts.push("Content-Type: text/html; charset=utf-8")
      mimeParts.push("Content-Transfer-Encoding: base64")
      mimeParts.push("")
      mimeParts.push(Buffer.from(htmlBody).toString("base64"))
      mimeParts.push("")
      mimeParts.push(`--${altBoundary}--`)

      for (const att of allAttachments) {
        const ct = att.content_type || "application/pdf"
        mimeParts.push("")
        mimeParts.push(`--${outerBoundary}`)
        mimeParts.push(`Content-Type: ${ct}; name="${att.filename}"`)
        mimeParts.push("Content-Transfer-Encoding: base64")
        mimeParts.push(`Content-Disposition: attachment; filename="${att.filename}"`)
        mimeParts.push("")
        mimeParts.push(att.content)
      }
      mimeParts.push("")
      mimeParts.push(`--${outerBoundary}--`)
    } else {
      mimeParts.push(`--${outerBoundary}`)
      mimeParts.push("Content-Type: text/plain; charset=utf-8")
      mimeParts.push("Content-Transfer-Encoding: base64")
      mimeParts.push("")
      mimeParts.push(Buffer.from(plainText).toString("base64"))
      mimeParts.push("")
      mimeParts.push(`--${outerBoundary}`)
      mimeParts.push("Content-Type: text/html; charset=utf-8")
      mimeParts.push("Content-Transfer-Encoding: base64")
      mimeParts.push("")
      mimeParts.push(Buffer.from(htmlBody).toString("base64"))
      mimeParts.push("")
      mimeParts.push(`--${outerBoundary}--`)
    }

    const mimeBody = mimeParts.join("\r\n")
    const encodedRaw = Buffer.from(mimeBody).toString("base64url")

    const sendPayload: Record<string, unknown> = { raw: encodedRaw }
    if (threadId) sendPayload.threadId = threadId

    const result = (await gmailPost(
      "/messages/send",
      sendPayload,
      params.as_user
    )) as { id: string; threadId: string; labelIds: string[] }

    // email_tracking row (only when tracking is on — matches gmail_send behavior)
    if (track_opens && trackingId) {
      await supabaseAdmin.from("email_tracking").insert({
        tracking_id: trackingId,
        gmail_message_id: result.id,
        gmail_thread_id: result.threadId,
        recipient: params.to,
        subject,
        from_email: fromEmail,
        account_id: params.account_id || null,
        contact_id: params.contact_id || null,
        lead_id: params.lead_id || null,
      })
    }

    logAction({
      action_type: "send",
      table_name: "gmail",
      record_id: result.id,
      account_id: params.account_id,
      contact_id: params.contact_id,
      summary: `Email sent -> ${params.to}: ${subject}`,
      details: {
        to: params.to,
        subject,
        cc: params.cc || null,
        tag: params.tag || null,
        has_attachments: hasAttachments,
        attachment_count: allAttachments.length,
        tracking_id: trackingId,
        lead_id: params.lead_id || null,
      },
    })

    // Lead auto-flip on offer sends — matches prior gmail_send behavior
    let leadAutoUpdated = false
    if (params.lead_id && params.tag === "offer") {
      const { error: leadErr } = await supabaseAdmin
        .from("leads")
        .update({
          status: "Offer Sent",
          offer_status: "Sent",
          updated_at: new Date().toISOString(),
        })
        .eq("id", params.lead_id)
      if (!leadErr) leadAutoUpdated = true
    }

    return {
      success: true,
      outcome: "sent",
      gmail_message_id: result.id,
      gmail_thread_id: result.threadId,
      tracking_id: trackingId,
      has_attachments: hasAttachments,
      attachment_count: allAttachments.length,
      attachment_filenames: allAttachments.map((a) => a.filename),
      lead_auto_updated: leadAutoUpdated,
    }
  } catch (error) {
    return {
      success: false,
      outcome: "error",
      has_attachments: false,
      attachment_count: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
