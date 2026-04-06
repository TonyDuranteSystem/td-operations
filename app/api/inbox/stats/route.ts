import { NextResponse } from "next/server"
import { gmailGet } from "@/lib/gmail"
import type { InboxStats } from "@/lib/types"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    // Gmail unread count only (WA/TG channels removed)
    const gmailResult = await gmailGet("/labels/INBOX") as {
      messagesUnread?: number
    } | null

    const gmailUnread = gmailResult?.messagesUnread || 0

    const stats: InboxStats = {
      gmail: gmailUnread,
      total: gmailUnread,
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
