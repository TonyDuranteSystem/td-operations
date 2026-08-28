/**
 * Own-Inbox READ path (dev_task 01800da8) — open an email from OUR store.
 *
 * Opening a thread used to fetch it in full from LIVE Gmail every time. That is
 * the last place the CRM depends on Gmail's per-user quota (the 2026-08-02
 * incident), and it is slow. When every message of a thread has been captured
 * we serve the whole thing from our own database + storage instead.
 *
 * STRICTLY local-first with a PER-MESSAGE guarantee: we only serve locally when
 * EVERY message of the thread is marked `complete` (the flag written last, only
 * after body + every attachment landed). Anything less — mid-backfill, an error
 * row, a thread we've never seen — returns null and the caller falls back to
 * live Gmail. A half-captured thread must never render as if it were whole.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { rewriteCidSources, safeEmailDate } from "@/lib/inbox/email-html"
import type { InboxMessage } from "@/lib/types"
import { EMAIL_CONTENT_BUCKET } from "./capture"
import { assertMailbox, type Mailbox } from "./paths"

// email tables aren't in the generated Database types yet (same escape as sync.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const OUR_ADDRESSES = ["support@tonydurante.us", "antonio.durante@tonydurante.us"]

export interface StoredThread {
  subject: string
  messages: InboxMessage[]
}

/**
 * A captured row's `is_html` column, when present, IS the real Gmail MIME type
 * (computed once by extractBodyWithType at capture time — lib/email-store/capture.ts).
 * Only rows captured before that column existed have it NULL; for those we fall
 * back to a content sniff, but a NARROW one: the same broad "any `<letter`" sniff
 * that lived here before (2026-08-27 fix) misclassified ordinary plain text
 * containing a bracketed link ("site.com <http://site.com/>") or a quoted
 * address ("Name <a@b.com>") as HTML — the exact bug class already fixed for the
 * live-Gmail path on 2026-07-08 (commit 88117e73) but never carried over here.
 * This fallback requires an actual structural/formatting tag token immediately
 * after `<` (or `</`), so a bracketed link or quoted address never matches.
 */
const STRUCTURAL_HTML_TAG =
  /<\/?\s*(html|body|div|table|span|img|font|strong|blockquote|ul|li|hr|br|em|h[1-6]|p|a|b|i|u)(?=[\s/>])/i

export function resolveMessageIsHtml(storedIsHtml: boolean | null | undefined, body: string): boolean {
  return storedIsHtml ?? STRUCTURAL_HTML_TAG.test(body)
}

/**
 * The whole thread from our store, or null if it isn't fully captured yet
 * (caller then falls back to live Gmail).
 */
export async function loadStoredThread(
  mailbox: Mailbox,
  threadId: string,
): Promise<StoredThread | null> {
  assertMailbox(mailbox)

  // Index rows = the authoritative message list for the thread (headers/dates).
  const { data: idxRows, error: idxErr } = await db
    .from("email_index")
    .select("message_id, from_email, from_name, to_emails, subject, internal_date, label_ids")
    .eq("mailbox", mailbox)
    .eq("thread_id", threadId)
    .order("internal_date", { ascending: true })
  if (idxErr || !idxRows || idxRows.length === 0) return null

  const messageIds = (idxRows as Array<{ message_id: string }>).map((r) => r.message_id)

  const { data: contentRows, error: cErr } = await db
    .from("email_message_content")
    .select("message_id, body_path, capture_status, is_html")
    .eq("mailbox", mailbox)
    .in("message_id", messageIds)
  if (cErr) return null

  const content = new Map(
    ((contentRows ?? []) as Array<{
      message_id: string; body_path: string | null; capture_status: string
      is_html: boolean | null
    }>)
      .map((r) => [r.message_id, r]),
  )
  // EVERY message must be complete — no partial threads.
  for (const id of messageIds) {
    const c = content.get(id)
    if (!c || c.capture_status !== "complete" || !c.body_path) return null
  }

  const { data: attRows } = await db
    .from("email_attachment")
    .select("message_id, gmail_attachment_id, filename, mime_type, size_bytes, is_inline, content_id")
    .eq("mailbox", mailbox)
    .in("message_id", messageIds)

  const attByMessage = new Map<string, Array<{
    message_id: string; gmail_attachment_id: string; filename: string | null
    mime_type: string | null; size_bytes: number | null; is_inline: boolean; content_id: string | null
  }>>()
  for (const a of (attRows ?? []) as never[]) {
    const row = a as unknown as { message_id: string } & Record<string, unknown>
    const list = attByMessage.get(row.message_id) ?? []
    list.push(row as never)
    attByMessage.set(row.message_id, list)
  }

  const bucket = supabaseAdmin.storage.from(EMAIL_CONTENT_BUCKET)
  const messages: InboxMessage[] = []

  for (const raw of idxRows as Array<{
    message_id: string; from_email: string | null; from_name: string | null
    to_emails: string[] | null; subject: string | null; internal_date: string | null
    label_ids: string[] | null
  }>) {
    const c = content.get(raw.message_id)!
    const dl = await bucket.download(c.body_path!)
    if (dl.error || !dl.data) return null // body unreadable → fall back to Gmail
    let body = await dl.data.text()

    const atts = attByMessage.get(raw.message_id) ?? []
    const inline = atts.filter((a) => a.is_inline && a.content_id)
    const usedInline = new Set<string>()
    if (body && inline.length > 0) {
      const byCid = new Map(inline.map((i) => [i.content_id as string, i]))
      body = rewriteCidSources(body, (cid) => {
        const img = byCid.get(cid)
        if (!img) return null
        usedInline.add(img.gmail_attachment_id)
        const mb = mailbox === "antonio" ? "&mailbox=antonio" : ""
        return `/api/inbox/attachment?messageId=${raw.message_id}&attachmentId=${encodeURIComponent(img.gmail_attachment_id)}&mimeType=${encodeURIComponent(img.mime_type || "image/png")}&filename=inline-image${mb}`
      })
    }

    const visible = atts
      .filter((a) => !usedInline.has(a.gmail_attachment_id))
      .filter((a) => !a.is_inline || !a.content_id)
      .map((a) => ({
        filename: a.filename || "attachment",
        mimeType: a.mime_type || "application/octet-stream",
        size: Number(a.size_bytes ?? 0),
        attachmentId: a.gmail_attachment_id,
      }))

    // Mirrors the live-fetch path's inlineImages field (app/api/inbox/messages/
    // [id]/route.ts) so Forward behaves the same whether a thread is served
    // locally or live (Antonio, 2026-08-28).
    const inlineImagesForForward = inline.map((a, i) => ({
      filename: a.filename || `inline-image-${i + 1}.${(a.mime_type || "image/png").split("/")[1] || "png"}`,
      mimeType: a.mime_type || "image/png",
      size: Number(a.size_bytes ?? 0),
      attachmentId: a.gmail_attachment_id,
    }))

    const fromAddr = raw.from_email || ""
    const isOutbound = OUR_ADDRESSES.some((a) => fromAddr.includes(a))
    const toLine = (raw.to_emails ?? []).join(", ")

    messages.push({
      id: raw.message_id,
      direction: isOutbound ? "outbound" : "inbound",
      sender: isOutbound ? toLine : (raw.from_name ? `${raw.from_name} <${fromAddr}>` : fromAddr),
      content: body,
      isHtml: resolveMessageIsHtml(c.is_html, body),
      type: "email",
      status: (raw.label_ids ?? []).includes("UNREAD") ? "new" : "read",
      createdAt: safeEmailDate(raw.internal_date ?? "", undefined),
      ...(visible.length > 0 ? { attachments: visible } : {}),
      ...(inlineImagesForForward.length > 0 ? { inlineImages: inlineImagesForForward } : {}),
    })
  }

  return {
    subject: (idxRows as Array<{ subject: string | null }>)[0]?.subject || "",
    messages,
  }
}

/** The stored attachment's bucket path, or null if we don't hold it. */
export async function storedAttachmentPath(
  mailbox: Mailbox,
  messageId: string,
  gmailAttachmentId: string,
): Promise<{ storage_path: string; mime_type: string | null } | null> {
  assertMailbox(mailbox)
  const { data } = await db
    .from("email_attachment")
    .select("storage_path, mime_type")
    .eq("mailbox", mailbox)
    .eq("message_id", messageId)
    .eq("gmail_attachment_id", gmailAttachmentId)
    .maybeSingle()
  return (data as { storage_path: string; mime_type: string | null } | null) ?? null
}
