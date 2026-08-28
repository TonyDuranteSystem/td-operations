import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  gmailGet,
  getHeader,
  extractBodyWithType,
  extractAttachments,
  extractInlineImages,
  type GmailAPIMessage,
} from "@/lib/gmail"
import { rewriteCidSources, safeEmailDate } from "@/lib/inbox/email-html"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import { loadStoredThread } from "@/lib/email-store/read"
import type { InboxMessage } from "@/lib/types"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = "force-dynamic"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Staff gate — middleware only guarantees "is logged in" for /api routes,
  // and a portal CLIENT has a login (2026-07-21 invariant; council find 2026-07-29,
  // dev job 7e63fcd2).
  const denied = await requireStaffRoute()
  if (denied) return denied

  try {
    const { id } = await params
    const limit = Math.min(
      parseInt(req.nextUrl.searchParams.get("limit") || "50"),
      200
    )
    const mailbox = req.nextUrl.searchParams.get("mailbox")
    if (!(await checkMailboxAccess(mailbox))) {
      return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
    }
    const asUser = mailbox === 'antonio'
      ? 'antonio.durante@tonydurante.us'
      : 'support@tonydurante.us'

    // ─── Gmail thread ────────────────────────────────
    // One view = one Gmail thread, exactly like the Gmail UI. The old
    // subject-based "related thread merging" (c7afbe79) is intentionally
    // GONE: Gmail's subject: search is contains-match, so same-sender
    // notifications and templated subjects merged threads ACROSS clients
    // (audit 2026-07-07). Gmail's native References-based threading is the
    // source of truth; our compose/reply paths set proper headers.
    if (id.startsWith("gmail:")) {
      const threadId = id.replace("gmail:", "")

      // LOCAL-FIRST: if every message of this thread is fully captured in our
      // own store, render it from there — no Gmail call at all. Opening a thread
      // was the last read path still spending Gmail quota (the 2026-08-02
      // incident). loadStoredThread returns null unless the WHOLE thread is
      // complete, so a half-captured thread always falls through to live Gmail.
      try {
        const stored = await loadStoredThread(
          mailbox === "antonio" ? "antonio" : "support",
          threadId,
        )
        if (stored) {
          return NextResponse.json({
            conversationId: id,
            channel: "gmail",
            subject: stored.subject,
            messages: stored.messages,
            servedFrom: "local",
          })
        }
      } catch (err) {
        console.warn("[inbox] local thread read failed, falling back to Gmail:", err)
      }

      const thread = (await gmailGet(`/threads/${threadId}`, {
        format: "full",
      }, asUser)) as {
        id: string
        messages: GmailAPIMessage[]
      }

      // Get subject from first message
      const subject = getHeader(
        thread.messages[0]?.payload?.headers,
        "Subject"
      )

      const allGmailMessages: GmailAPIMessage[] = [...thread.messages]

      // Sort messages chronologically
      allGmailMessages.sort((a, b) => {
        const dateA = parseInt(a.internalDate || "0")
        const dateB = parseInt(b.internalDate || "0")
        return dateA - dateB
      })

      // Convert to InboxMessage format
      const messages: InboxMessage[] = allGmailMessages.map((msg) => {
        const from = getHeader(msg.payload.headers, "From")
        const to = getHeader(msg.payload.headers, "To")
        const date = getHeader(msg.payload.headers, "Date")
        // Real MIME type from the chosen part — the client must NOT guess
        // HTML-ness from the content (plain replies quoting `<a@b.com>`
        // misrender as HTML and lose all line breaks).
        const extracted = extractBodyWithType(msg.payload)
        let body = extracted.body

        // Resolve inline images: rewrite `src="cid:X"` references to our
        // attachment-download endpoint so the browser can load them.
        const inlineImages = extractInlineImages(msg.payload)
        const usedInline = new Set<string>()
        if (body && inlineImages.length > 0) {
          const byCid = new Map(inlineImages.map((i) => [i.contentId, i]))
          body = rewriteCidSources(body, (cid) => {
            const img = byCid.get(cid)
            if (!img) return null
            usedInline.add(img.attachmentId)
            const mb = mailbox === "antonio" ? "&mailbox=antonio" : ""
            return `/api/inbox/attachment?messageId=${msg.id}&attachmentId=${encodeURIComponent(img.attachmentId)}&mimeType=${encodeURIComponent(img.mimeType)}&filename=inline-image${mb}`
          })
        }

        // Hide attachments that render inline in the body (Gmail does the same)
        const attachments = extractAttachments(msg.payload).filter(
          (a) => !usedInline.has(a.attachmentId)
        )

        // Separately expose inline images (excluded from `attachments` above
        // so the thread view doesn't double-show them) so Forward can offer
        // the original's images too, not just real attachments (Antonio,
        // 2026-08-28). Filenames are synthesized — Gmail doesn't give inline
        // parts one.
        const inlineImagesForForward = inlineImages.map((img, i) => ({
          filename: `inline-image-${i + 1}.${img.mimeType.split("/")[1] || "png"}`,
          mimeType: img.mimeType,
          size: img.size,
          attachmentId: img.attachmentId,
        }))

        const isOutbound =
          from.includes("support@tonydurante.us") ||
          from.includes("antonio.durante@tonydurante.us")

        return {
          id: msg.id,
          direction: isOutbound ? "outbound" : "inbound",
          sender: isOutbound ? to : from,
          content: body,
          isHtml: extracted.isHtml,
          type: "email",
          status: msg.labelIds?.includes("UNREAD") ? "new" : "read",
          // A spam sender's malformed Date header must not 500 the whole
          // thread — safeEmailDate never throws.
          createdAt: safeEmailDate(date, msg.internalDate),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(inlineImagesForForward.length > 0 ? { inlineImages: inlineImagesForForward } : {}),
        }
      })

      return NextResponse.json({
        conversationId: id,
        channel: "gmail",
        subject,
        messages,
      })
    }

    // ─── Supabase messaging group ────────────────────
    const { data: group } = await supabaseAdmin
      .from("messaging_groups")
      .select(
        "id, group_name, external_group_id, channel_id, account_id, contact_id, unread_count, messaging_channels(provider)"
      )
      .eq("id", id)
      .single()

    if (!group) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      )
    }

    const { data: msgs, error } = await supabaseAdmin
      .from("messages")
      .select(
        "id, direction, sender_phone, sender_name, content_text, content_type, status, created_at, metadata"
      )
      .eq("group_id", id)
      .order("created_at", { ascending: true })
      .limit(limit)

    if (error) throw error

    // Build phone-to-name map for resolving sender names
    const phoneNames: Record<string, string> = {
      "17274234285": "Antonio Durante",
      "17272535199": "Tony Durante LLC",
      "17274521093": "Tony Durante LLC",
    }

    // Get unique phone-like sender_names to resolve from CRM contacts
    const phoneSenders = Array.from(new Set(
      (msgs || [])
        .map(m => m.sender_name || m.sender_phone)
        .filter((s): s is string => !!s && /^\d{8,}$/.test(s) && !phoneNames[s])
    ))

    if (phoneSenders.length > 0) {
      // Search CRM contacts by phone number
      const { data: contacts } = await supabaseAdmin
        .from("contacts")
        .select("full_name, phone")
        .not("phone", "is", null)

      if (contacts) {
        for (const contact of contacts) {
          if (!contact.phone || !contact.full_name) continue
          // Normalize phone: strip +, spaces, dashes
          const normalized = contact.phone.replace(/[\s\-\+\(\)]/g, "")
          // Match against sender numbers (which may or may not have country code)
          for (const sender of phoneSenders) {
            if (normalized.endsWith(sender) || sender.endsWith(normalized) || normalized === sender) {
              phoneNames[sender] = contact.full_name
            }
          }
        }
      }
    }

    const messages: InboxMessage[] = (msgs || []).map((m) => {
      const rawSender = m.sender_name || m.sender_phone || "Unknown"
      const resolvedName = phoneNames[rawSender] || rawSender
      return {
        id: m.id,
        direction: m.direction as "inbound" | "outbound",
        sender: resolvedName,
        content: m.content_text || "",
        type: m.content_type || "text",
        status: m.status || "new",
        createdAt: m.created_at,
        metadata: m.metadata as Record<string, unknown> | undefined,
      }
    })

    const provider =
      group.messaging_channels &&
      typeof group.messaging_channels === "object"
        ? (group.messaging_channels as { provider?: string }).provider
        : null

    return NextResponse.json({
      conversationId: id,
      channel: provider === "telegram_bot_api" ? "telegram" : "whatsapp",
      name: group.group_name,
      externalId: group.external_group_id,
      accountId: group.account_id,
      messages,
    })
  } catch (error) {
    console.error("Inbox messages error:", error)
    const errMsg = error instanceof Error ? error.message : JSON.stringify(error)
    return NextResponse.json(
      { error: "Failed to fetch messages", detail: errMsg },
      { status: 500 }
    )
  }
}
