/**
 * TD Marketing — Gmail's answers turned into the Inbox's own shapes (pure; dev job 9aec66fa). Mirrors what the CRM Inbox does when it opens a thread, without any of its CRM parts:
 * the real MIME type picks HTML or text, inline pictures are pointed at OUR attachment route, HTML is sanitized here (never trusted from Gmail), a malformed Date never breaks a thread.
 */
import {
  extractAttachments, extractBodyWithType, extractInlineImages, getHeader, type GmailAPIMessage,
} from "@/lib/gmail"
import { decodeHtmlEntities, displayNameFromHeader, htmlToPlainText, rewriteCidSources, safeEmailDate } from "@/lib/inbox/email-html"
import { sanitizeEmailHtml } from "@/lib/html-escape"
import type { Folder, MailMessage, MailThread, ThreadRow } from "@/lib/marketing/inbox/mail-types"

export const PAGE_SIZE = 25

/** The Gmail list parameters for a folder and a search ("" = none). Starred keeps everything starred, wherever it lives. */
export function listParams(folder: Folder, q: string, pageToken?: string | null): Record<string, string> {
  const label = { inbox: "INBOX", sent: "SENT", drafts: "DRAFT", starred: "STARRED" }[folder]
  const params: Record<string, string> = { labelIds: label, maxResults: String(PAGE_SIZE) }
  const query = q.trim().slice(0, 300)
  if (query) params.q = query
  if (pageToken) params.pageToken = pageToken
  return params
}

const emailOf = (header: string): string => {
  const m = header.match(/<([^>]+)>/)
  return (m ? m[1] : header).trim().toLowerCase()
}

interface RawThread { id: string; messages?: GmailAPIMessage[] }

/** One list row from a thread fetched with metadata only. */
export function parseThreadRow(raw: RawThread, mailbox: string): ThreadRow {
  const msgs = [...(raw.messages ?? [])].sort((a, b) => parseInt(a.internalDate || "0") - parseInt(b.internalDate || "0"))
  const first = msgs[0]
  const last = msgs[msgs.length - 1]
  const subject = decodeHtmlEntities(getHeader(first?.payload?.headers, "Subject")).trim() || "(no subject)"
  // the other side of the newest message: its sender, or (when we wrote it) its first recipient
  let who = "me"
  if (last) {
    const from = getHeader(last.payload.headers, "From")
    const ours = emailOf(from) === mailbox
    const other = ours ? getHeader(last.payload.headers, "To").split(",")[0] ?? "" : from
    who = displayNameFromHeader(other) || emailOf(other) || "me"
    // a message we wrote to ourselves, or with no recipient (a draft): nobody else to name
    if (ours && (!other.trim() || emailOf(other) === mailbox)) who = "me"
  }
  return {
    id: raw.id,
    subject,
    who,
    snippet: decodeHtmlEntities(last?.snippet ?? "").trim(),
    date: safeEmailDate(getHeader(last?.payload?.headers, "Date"), last?.internalDate),
    unread: msgs.some(m => m.labelIds?.includes("UNREAD")),
    count: msgs.length,
  }
}

/** A whole thread (format=full) as the Inbox shows it. `attachmentUrl` builds the address an inline picture is loaded from. */
export function parseThreadFull(
  raw: RawThread & { messages: GmailAPIMessage[] },
  mailbox: string,
  attachmentUrl: (messageId: string, attachmentId: string, mimeType: string) => string,
): MailThread {
  const msgs = [...raw.messages].sort((a, b) => parseInt(a.internalDate || "0") - parseInt(b.internalDate || "0"))
  const messages: MailMessage[] = msgs.map(msg => {
    const h = msg.payload.headers
    const from = getHeader(h, "From")
    const extracted = extractBodyWithType(msg.payload)
    let body = extracted.body
    const inline = extractInlineImages(msg.payload)
    const used = new Set<string>()
    if (body && inline.length > 0 && extracted.isHtml) {
      const byCid = new Map(inline.map(i => [i.contentId, i]))
      body = rewriteCidSources(body, cid => {
        const img = byCid.get(cid)
        if (!img) return null
        used.add(img.attachmentId)
        return attachmentUrl(msg.id, img.attachmentId, img.mimeType)
      })
    }
    const text = extracted.isHtml ? htmlToPlainText(body) : body
    return {
      id: msg.id,
      from: displayNameFromHeader(from) || emailOf(from),
      fromEmail: emailOf(from),
      to: getHeader(h, "To"),
      cc: getHeader(h, "Cc"),
      bcc: getHeader(h, "Bcc"),
      date: safeEmailDate(getHeader(h, "Date"), msg.internalDate),
      subject: decodeHtmlEntities(getHeader(h, "Subject")),
      html: extracted.isHtml ? sanitizeEmailHtml(body) : null,
      text,
      unread: !!msg.labelIds?.includes("UNREAD"),
      draft: !!msg.labelIds?.includes("DRAFT"),
      outbound: emailOf(from) === mailbox,
      attachments: extractAttachments(msg.payload)
        .filter(a => !used.has(a.attachmentId))
        .map(a => ({ messageId: msg.id, attachmentId: a.attachmentId, filename: a.filename, mimeType: a.mimeType, size: a.size })),
      messageIdHeader: getHeader(h, "Message-ID") || getHeader(h, "Message-Id"),
      references: getHeader(h, "References"),
    }
  })
  const starred = msgs.some(m => m.labelIds?.includes("STARRED"))
  return { id: raw.id, subject: decodeHtmlEntities(getHeader(msgs[0]?.payload?.headers, "Subject")).trim() || "(no subject)", messages, starred }
}
