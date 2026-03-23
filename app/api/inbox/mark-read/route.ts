import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailGet, gmailPost } from "@/lib/gmail"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { conversationId, channel, mailbox } = body as {
      conversationId: string
      channel?: string
      mailbox?: string
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: "conversationId is required" },
        { status: 400 }
      )
    }

    const asUser = mailbox === 'antonio'
      ? 'antonio.durante@tonydurante.us'
      : 'support@tonydurante.us'

    // ─── Gmail: remove UNREAD label from ALL messages in thread ──────────────────
    if (channel === "gmail" || conversationId.startsWith("gmail:")) {
      const threadId = conversationId.replace("gmail:", "")

      // Get all messages in thread, then remove UNREAD from each
      const thread = (await gmailGet(`/threads/${threadId}`, { format: 'minimal' }, asUser)) as {
        messages: Array<{ id: string; labelIds?: string[] }>
      }

      const allMsgs = thread.messages ?? []
      const unreadMsgs = allMsgs.filter(m => m.labelIds?.includes('UNREAD'))

      // Debug: log what Gmail returned
      console.log(`[MarkRead] Thread ${threadId}: ${allMsgs.length} messages, ${unreadMsgs.length} unread`)
      if (allMsgs.length > 0) {
        console.log(`[MarkRead] First message labels: ${JSON.stringify(allMsgs[0].labelIds)}`)
      }

      if (unreadMsgs.length > 0) {
        await Promise.all(
          unreadMsgs.map(m =>
            gmailPost(`/messages/${m.id}/modify`, { removeLabelIds: ['UNREAD'] }, asUser)
          )
        )
      } else if (allMsgs.length > 0) {
        // Fallback: if no UNREAD labels found but messages exist,
        // try removing UNREAD from ALL messages anyway
        console.log(`[MarkRead] Fallback: removing UNREAD from all ${allMsgs.length} messages`)
        await Promise.all(
          allMsgs.map(m =>
            gmailPost(`/messages/${m.id}/modify`, { removeLabelIds: ['UNREAD'] }, asUser)
          )
        )
      }

      return NextResponse.json({
        success: true,
        channel: "gmail",
        marked: unreadMsgs.length || allMsgs.length,
        debug: { totalMessages: allMsgs.length, unreadFound: unreadMsgs.length }
      })
    }

    // ─── Supabase: mark all new inbound as read ──────
    const { data, error } = await supabaseAdmin
      .from("messages")
      .update({ status: "read" })
      .eq("group_id", conversationId)
      .eq("status", "new")
      .eq("direction", "inbound")
      .select("id")

    if (error) throw error

    // Also reset unread_count on the group
    await supabaseAdmin
      .from("messaging_groups")
      .update({ unread_count: 0 })
      .eq("id", conversationId)

    return NextResponse.json({
      success: true,
      channel: channel || "whatsapp",
      marked: data?.length || 0,
    })
  } catch (error) {
    console.error("Mark read error:", error)
    return NextResponse.json(
      { error: "Failed to mark as read" },
      { status: 500 }
    )
  }
}
