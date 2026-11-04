import { NextResponse } from "next/server"
import { gmailGet } from "@/lib/gmail"
import { getWhatsappUnread } from "@/lib/inbox/whatsapp-unread"
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
    // WhatsApp ONLY — never Telegram (see lib/inbox/whatsapp-unread.ts for why).
    const [gmailResult, whatsappUnread] = await Promise.all([
      Promise.resolve(gmailGet("/labels/INBOX") as Promise<{ messagesUnread?: number } | null>).then(
        (value) => ({ status: "fulfilled" as const, value }),
        () => ({ status: "rejected" as const, value: null }),
      ),
      getWhatsappUnread(),
    ])

    const gmailUnread =
      gmailResult.status === "fulfilled"
        ? (gmailResult.value?.messagesUnread ?? 0)
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
