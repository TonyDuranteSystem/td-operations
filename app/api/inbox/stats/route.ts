import { NextResponse } from "next/server"
import { gmailGet } from "@/lib/gmail"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { InboxStats } from "@/lib/types"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

// messaging_groups holds WhatsApp, Telegram (and any future platform) rows —
// messaging_channels.platform distinguishes them. Summing unread_count with
// no platform filter silently folded Telegram's unread count into the
// "WhatsApp" badge (Antonio, 2026-09-19: badge showed 5 unread with nothing
// unread visible in the WhatsApp list; the 5 was 2 unread Telegram
// conversations). This resolves channel ids for ONE platform first, then
// sums only those groups' unread_count — reused for both platforms below so
// a third channel never repeats the same mistake.
async function unreadCountForPlatform(platform: "whatsapp" | "telegram"): Promise<number> {
  const { data: channelRows } = await supabaseAdmin
    .from("messaging_channels")
    .select("id")
    .eq("platform", platform)
  const channelIds = (channelRows ?? []).map((c) => c.id)
  if (!channelIds.length) return 0

  const { data, error } = await supabaseAdmin
    .from("messaging_groups")
    .select("unread_count")
    .eq("is_active", true)
    .gt("unread_count", 0)
    .in("channel_id", channelIds)

  if (error || !data) return 0
  return data.reduce((sum: number, row: { unread_count: number }) => sum + (row.unread_count ?? 0), 0)
}

export const dynamic = "force-dynamic"

export async function GET() {
  // Staff gate — middleware only guarantees "is logged in" for /api routes,
  // and a portal CLIENT has a login (2026-07-21 invariant; council find 2026-07-29,
  // dev job 7e63fcd2).
  const denied = await requireStaffRoute()
  if (denied) return denied

  try {
    const [gmailResult, whatsappUnread, telegramUnread] = await Promise.allSettled([
      gmailGet("/labels/INBOX") as Promise<{ messagesUnread?: number } | null>,
      unreadCountForPlatform("whatsapp"),
      unreadCountForPlatform("telegram"),
    ])

    const gmailUnread =
      gmailResult.status === "fulfilled"
        ? (gmailResult.value?.messagesUnread ?? 0)
        : 0
    const wa = whatsappUnread.status === "fulfilled" ? whatsappUnread.value : 0
    const tg = telegramUnread.status === "fulfilled" ? telegramUnread.value : 0

    const stats: InboxStats = {
      gmail: gmailUnread,
      whatsapp: wa,
      telegram: tg,
      total: gmailUnread + wa + tg,
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
