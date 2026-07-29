import { NextResponse } from "next/server"
import { gmailGet } from "@/lib/gmail"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { InboxStats } from "@/lib/types"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = "force-dynamic"

export async function GET() {
  // Staff gate — middleware only guarantees "is logged in" for /api routes,
  // and a portal CLIENT has a login (2026-07-21 invariant; council find 2026-07-29,
  // dev job 7e63fcd2).
  const denied = await requireStaffRoute()
  if (denied) return denied

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
