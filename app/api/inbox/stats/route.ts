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
    // messaging_groups holds BOTH WhatsApp and Telegram rows (messaging_channels.platform
    // distinguishes them) — summing unread_count with no platform filter silently folded
    // Telegram's unread count into the "WhatsApp" badge (Antonio, 2026-09-19: badge showed
    // 5 unread with nothing unread visible in the WhatsApp list; the 5 was 2 unread Telegram
    // conversations). Filter to whatsapp channel ids explicitly.
    const { data: whatsappChannelRows } = await supabaseAdmin
      .from("messaging_channels")
      .select("id")
      .eq("platform", "whatsapp")
    const whatsappChannelIds = (whatsappChannelRows ?? []).map((c) => c.id)

    const [gmailResult, waResult] = await Promise.allSettled([
      gmailGet("/labels/INBOX") as Promise<{ messagesUnread?: number } | null>,
      whatsappChannelIds.length
        ? supabaseAdmin
            .from("messaging_groups")
            .select("unread_count")
            .eq("is_active", true)
            .gt("unread_count", 0)
            .in("channel_id", whatsappChannelIds)
        : Promise.resolve({ data: [], error: null }),
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
