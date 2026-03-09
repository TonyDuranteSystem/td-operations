import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailGet } from "@/lib/gmail"
import type { InboxStats } from "@/lib/types"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    // Parallel: Supabase unread counts (from view) + Gmail unread count
    const [viewResult, gmailResult] = await Promise.allSettled([
      supabaseAdmin
        .from("v_messaging_inbox")
        .select("platform, unread_count"),
      gmailGet("/labels/INBOX") as Promise<{
        messagesUnread?: number
      }>,
    ])

    let whatsappUnread = 0
    let telegramUnread = 0

    if (viewResult.status === "fulfilled" && viewResult.value.data) {
      for (const row of viewResult.value.data) {
        const count = row.unread_count || 0
        if (row.platform === "whatsapp") whatsappUnread += count
        else if (row.platform === "telegram") telegramUnread += count
      }
    }

    const gmailUnread =
      gmailResult.status === "fulfilled"
        ? gmailResult.value.messagesUnread || 0
        : 0

    const stats: InboxStats = {
      whatsapp: whatsappUnread,
      telegram: telegramUnread,
      gmail: gmailUnread,
      total: whatsappUnread + telegramUnread + gmailUnread,
    }

    return NextResponse.json(stats)
  } catch (error) {
    console.error("Inbox stats error:", error)
    return NextResponse.json(
      { error: "Failed to fetch inbox stats" },
      { status: 500 }
    )
  }
}
