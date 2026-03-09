import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailPost } from "@/lib/gmail"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { conversationId, channel } = body as {
      conversationId: string
      channel?: string
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: "conversationId is required" },
        { status: 400 }
      )
    }

    // ─── Gmail: remove UNREAD label ──────────────────
    if (channel === "gmail" || conversationId.startsWith("gmail:")) {
      const threadId = conversationId.replace("gmail:", "")

      await gmailPost(`/threads/${threadId}/modify`, {
        removeLabelIds: ["UNREAD"],
      })

      return NextResponse.json({ success: true, channel: "gmail", marked: 1 })
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
