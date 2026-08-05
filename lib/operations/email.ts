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
import {
  buildSignatureHtml,
  buildSignatureText,
  hasSignature,
  parseSignatureVariant,
  signatureFromName,
  signatureSenderForAddress,
  DEFAULT_SIGNATURE_VARIANT,
  type SignatureVariant,
} from "@/lib/email/signature"

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
  /**
   * When true, body_html is wrapped with the TD-branded shell (logo, font,
   * footer). If body_html is plain text, newlines are converted to
   * paragraphs/breaks first. Default false — preserves existing behavior for
   * dedicated send tools that build their own HTML shells.
   */
  wrap_with_brand?: boolean
  /**
   * Which signature the sender picked for THIS email: "gala" | "hat" (full
   * block, with Antonio's portrait when it leaves from his address) or
   * "text" (identity block only, no images). Only read when
   * wrap_with_brand is on. Defaults to the award portrait.
   */
  signature_variant?: SignatureVariant
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

// ─── Plain-text -> HTML + branded shell ─────────────────────

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function looksLikeHtml(input: string): boolean {
  return /<\s*[a-z][a-z0-9]*\b[^>]*>/i.test(input)
}

/**
 * Best-effort HTML -> readable plain text (tag strip + entity decode).
 * Fine for paragraph-shaped content; NOT fine for table layouts, whose cells
 * produce no whitespace — which is why signature text is authored, never
 * pushed through here.
 */
export function htmlToPlainText(html: string): string {
  return html
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
}

/**
 * Convert a plain-text string (with blank lines as paragraph separators and
 * single newlines as line breaks) to HTML paragraphs. Always escapes HTML
 * entities — assume input is plain text. Callers who already have HTML
 * should branch on looksLikeHtml() and skip this function.
 */
export function plainTextToParagraphs(input: string): string {
  const paragraphs = input
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  return paragraphs
    .map((p) => {
      const escaped = escapeHtml(p).replace(/\n/g, "<br />")
      return `<p>${escaped}</p>`
    })
    .join("\n")
}

/**
 * Wrap a body fragment with the TD shell: Arial stack, readable colour, and
 * the sender's signature at the bottom.
 *
 * The logo used to sit in a BANNER above the message and the footer carried
 * only "Tony Durante LLC / support@" - no human name, no title, no phone.
 * Business mail puts its branding in the signature, so the logo moved down
 * into it and the old footer is gone (Antonio, 2026-08-05). Everything the
 * block says now comes from lib/email/signature.ts, which the reply and
 * worker paths share, so the three can no longer drift apart.
 */
export function wrapEmailWithBrandShell(
  bodyHtml: string,
  signature: {
    sender: ReturnType<typeof signatureSenderForAddress>
    variant: SignatureVariant
  } = { sender: "support", variant: DEFAULT_SIGNATURE_VARIANT }
): string {
  // On "none" the signature line is dropped entirely rather than left as an
  // empty line inside the shell.
  //
  // includeSignoff FALSE: everything wrapped here is human-authored (the
  // compose dialog), and Antonio's real sent mail shows he usually types his
  // own closing - an automatic "Best regards," on top produced a double
  // closing on most composed emails (bug-hunter MAJOR, 2026-08-05). Same
  // rule the reply path always had. The occasional email with no typed
  // closing runs straight into the name block, which reads fine; the worker
  // paths keep the sign-off because the model writes none.
  const sig = buildSignatureHtml({
    sender: signature.sender,
    variant: signature.variant,
    includeSignoff: false,
  })
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
${bodyHtml}${sig ? `\n${sig}` : ""}
</div>`
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
    let body_html = sanitizeToAscii(params.body_html)
    let body_text = params.body_text ? sanitizeToAscii(params.body_text) : undefined

    // Resolved BEFORE the shell: whose signature goes on this mail is decided
    // by which mailbox it leaves from, so the address has to be known first.
    const fromEmail = params.as_user || DEFAULT_EMAIL()
    const signatureSender = signatureSenderForAddress(fromEmail)

    // Brand-shell wrapping: plain text becomes paragraphs, then the sender's
    // signature is appended. Opt-in via wrap_with_brand.
    if (params.wrap_with_brand) {
      const bodyWasHtml = looksLikeHtml(body_html)
      const contentHtml = bodyWasHtml ? body_html : plainTextToParagraphs(body_html)
      const variant = parseSignatureVariant(params.signature_variant)
      body_html = wrapEmailWithBrandShell(contentHtml, {
        sender: signatureSender,
        variant,
      })

      // The text/plain half must be AUTHORED, not derived. The generic
      // fallback below strips tags out of the FULL html - including the
      // signature table, whose cells produce no whitespace, so the block
      // came out glued together ("Best regards,Tony Durante LLC" - bug
      // hunter, 2026-08-05). So for EVERY wrapped send with no caller text:
      // derive text from the CONTENT only, then append the signature's own
      // authored plain form. includeSignoff false, mirroring the HTML half.
      //
      // On "none" the separator is skipped too, not just the block: appending
      // "\n\n" + "" would leave the email ending in blank lines.
      if (!body_text) {
        const contentText = bodyWasHtml
          ? htmlToPlainText(contentHtml)
          : sanitizeToAscii(params.body_html).trim()
        const sigText = hasSignature(variant)
          ? sanitizeToAscii(
              buildSignatureText({ sender: signatureSender, variant, includeSignoff: false })
            )
          : ""
        body_text = sigText ? `${contentText}\n\n${sigText}` : contentText
      }
    }

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

    // Plain text fallback derived from HTML when not provided. Wrapped sends
    // never reach this (their text half is authored above); this covers the
    // dedicated senders that build their own HTML and pass no body_text.
    const plainText = body_text || htmlToPlainText(htmlBody)

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
      // The From name follows the mailbox. Mail from Antonio's address signed
      // "Antonio Noel Durante" must not arrive labelled as the company.
      `From: ${signatureFromName(signatureSender)} <${fromEmail}>`,
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
