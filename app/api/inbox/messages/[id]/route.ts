import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  gmailGet,
  getHeader,
  extractBody,
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

    // ─── Gmail thread ────────────────────────────────
    if (id.startsWith("gmail:")) {
      const threadId = id.replace("gmail:", "")

      const thread = (await gmailGet(`/threads/${threadId}`, {
        format: "full",
      })) as {
        id: string
        messages: GmailAPIMessage[]
      }

      const messages: InboxMessage[] = thread.messages.map((msg) => {
        const from = getHeader(msg.payload.headers, "From")
        const to = getHeader(msg.payload.headers, "To")
        const date = getHeader(msg.payload.headers, "Date")
        const body = extractBody(msg.payload)

        // Determine direction: if from contains support@tonydurante.us → outbound
        const isOutbound =
          from.includes("support@tonydurante.us") ||
          from.includes("antonio.durante@tonydurante.us")

        return {
          id: msg.id,
          direction: isOutbound ? "outbound" : "inbound",
          sender: isOutbound ? to : from,
          content: body.length > 3000 ? body.slice(0, 3000) + "..." : body,
          type: "email",
          status: msg.labelIds?.includes("UNREAD") ? "new" : "read",
          createdAt: date
            ? new Date(date).toISOString()
            : new Date(parseInt(msg.internalDate)).toISOString(),
        }
      })

      // Get subject from first message
      const subject = getHeader(
        thread.messages[0]?.payload?.headers,
        "Subject"
      )

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
        "id, direction, sender_phone, sender_name, content_text, message_type, status, created_at, metadata"
      )
      .eq("group_id", id)
      .order("created_at", { ascending: true })
      .limit(limit)

    if (error) throw error

    const messages: InboxMessage[] = (msgs || []).map((m) => ({
      id: m.id,
      direction: m.direction as "inbound" | "outbound",
      sender: m.sender_name || m.sender_phone || "Unknown",
      content: m.content_text || "",
      type: m.message_type || "text",
      status: m.status || "new",
      createdAt: m.created_at,
      metadata: m.metadata as Record<string, unknown> | undefined,
    }))

    const provider =
      group.messaging_channels &&
      typeof group.messaging_channels === "object"
        ? (group.messaging_channels as { provider?: string }).provider
        : null

    return NextResponse.json({
      conversationId: id,
      channel: provider === "Telegram" ? "telegram" : "whatsapp",
      name: group.group_name,
      externalId: group.external_group_id,
      accountId: group.account_id,
      messages,
    })
  } catch (error) {
    console.error("Inbox messages error:", error)
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 }
    )
  }
}
