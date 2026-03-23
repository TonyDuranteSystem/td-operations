import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  gmailGet,
  getHeader,
  extractBodyHtml,
  extractAttachments,
  type GmailAPIMessage,
} from "@/lib/gmail"
import type { InboxMessage } from "@/lib/types"

export const dynamic = "force-dynamic"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const limit = Math.min(
      parseInt(req.nextUrl.searchParams.get("limit") || "50"),
      200
    )
    const mailbox = req.nextUrl.searchParams.get("mailbox")
    const asUser = mailbox === 'antonio'
      ? 'antonio.durante@tonydurante.us'
      : 'support@tonydurante.us'

    // ─── Gmail thread (with related thread merging) ──
    if (id.startsWith("gmail:")) {
      const threadId = id.replace("gmail:", "")

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

      // Collect all Gmail messages — start with this thread's messages
      let allGmailMessages: GmailAPIMessage[] = [...thread.messages]
      const seenMessageIds = new Set(thread.messages.map(m => m.id))

      // Find related threads: same subject, different thread ID
      // Strip "Re: " / "Fwd: " prefixes for matching
      const baseSubject = subject
        .replace(/^(Re|Fwd|FW|RE):\s*/gi, '')
        .replace(/^(Re|Fwd|FW|RE):\s*/gi, '') // double strip for "Re: Re:"
        .trim()

      if (baseSubject.length > 3) {
        try {
          const searchResult = (await gmailGet("/threads", {
            q: `subject:"${baseSubject}"`,
            maxResults: "10",
          }, asUser)) as {
            threads?: Array<{ id: string }>
          }

          // Fetch related threads (different ID, same subject)
          const relatedThreadIds = (searchResult.threads || [])
            .map(t => t.id)
            .filter(tid => tid !== threadId)
            .slice(0, 5) // max 5 related threads

          if (relatedThreadIds.length > 0) {
            const relatedResults = await Promise.allSettled(
              relatedThreadIds.map(tid =>
                gmailGet(`/threads/${tid}`, { format: "full" }, asUser) as Promise<{
                  id: string
                  messages: GmailAPIMessage[]
                }>
              )
            )

            for (const result of relatedResults) {
              if (result.status !== "fulfilled") continue
              for (const msg of result.value.messages) {
                if (!seenMessageIds.has(msg.id)) {
                  seenMessageIds.add(msg.id)
                  allGmailMessages.push(msg)
                }
              }
            }
          }
        } catch {
          // If related search fails, just use the original thread
        }
      }

      // Sort all messages chronologically
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
        const body = extractBodyHtml(msg.payload)
        const attachments = extractAttachments(msg.payload)

        const isOutbound =
          from.includes("support@tonydurante.us") ||
          from.includes("antonio.durante@tonydurante.us")

        return {
          id: msg.id,
          direction: isOutbound ? "outbound" : "inbound",
          sender: isOutbound ? to : from,
          content: body.length > 50000 ? body.slice(0, 50000) + "..." : body,
          type: "email",
          status: msg.labelIds?.includes("UNREAD") ? "new" : "read",
          createdAt: date
            ? new Date(date).toISOString()
            : new Date(parseInt(msg.internalDate)).toISOString(),
          ...(attachments.length > 0 ? { attachments } : {}),
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
