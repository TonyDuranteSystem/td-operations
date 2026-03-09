import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailGet } from "@/lib/gmail"
import type { InboxStats } from "@/lib/types"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    // Parallel: Supabase unread counts + Gmail unread count
    const [channelsResult, gmailResult] = await Promise.allSettled([
      supabaseAdmin
        .from("messaging_channels")
        .select("id, provider")
        .eq("is_active", true),
      gmailGet("/labels/INBOX") as Promise<{
        messagesUnread?: number
      }>,
    ])

    let whatsappUnread = 0
    let telegramUnread = 0

    if (channelsResult.status === "fulfilled" && channelsResult.value.data) {
      const channels = channelsResult.value.data
      for (const ch of channels) {
        const { data } = await supabaseAdmin
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("channel_id", ch.id)
          .eq("status", "new")
          .eq("direction", "inbound")

        const count = (data as unknown as { count?: number })?.count || 0
        if (ch.provider === "WhatsApp") whatsappUnread += count
        else if (ch.provider === "Telegram") telegramUnread += count
      }

      // Simpler: query all unread by joining
      const { count: waCount } = await supabaseAdmin
        .from("messages")
        .select("id, messaging_channels!inner(provider)", {
          count: "exact",
          head: true,
        })
        .eq("messaging_channels.provider", "WhatsApp")
        .eq("status", "new")
        .eq("direction", "inbound")

      const { count: tgCount } = await supabaseAdmin
        .from("messages")
        .select("id, messaging_channels!inner(provider)", {
          count: "exact",
          head: true,
        })
        .eq("messaging_channels.provider", "Telegram")
        .eq("status", "new")
        .eq("direction", "inbound")

      whatsappUnread = waCount || 0
      telegramUnread = tgCount || 0
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
