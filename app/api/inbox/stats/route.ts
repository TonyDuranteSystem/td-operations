import { NextResponse } from "next/server"
import { gmailGet } from "@/lib/gmail"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { InboxStats } from "@/lib/types"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const [gmailResult, waResult] = await Promise.allSettled([
      gmailGet("/labels/INBOX") as Promise<{ messagesUnread?: number } | null>,
      supabaseAdmin
        .from("messaging_groups")
        .select("unread_count")
        .gt("unread_count", 0),
    ])

    const gmailUnread =
      gmailResult.status === "fulfilled"
        ? (gmailResult.value?.messagesUnread ?? 0)
        : 0

    const whatsappUnread =
      waResult.status === "fulfilled" && !waResult.value.error
        ? (waResult.value.data ?? []).reduce(
            (sum: number, row: { unread_count: number }) =>
              sum + (row.unread_count ?? 0),
            0
          )
        : 0

    const stats: InboxStats = {
      gmail: gmailUnread,
      whatsapp: whatsappUnread,
      total: gmailUnread + whatsappUnread,
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
