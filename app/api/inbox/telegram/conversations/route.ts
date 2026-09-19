import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { InboxConversation } from "@/lib/types"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = "force-dynamic"

/** Telegram counterpart of app/api/inbox/whatsapp/conversations — identical shape,
 *  filtered to `messaging_channels.platform = 'telegram'` instead of 'whatsapp'. */
export async function GET() {
  const denied = await requireStaffRoute()
  if (denied) return denied

  try {
    const { data: channelRows, error: chErr } = await supabaseAdmin
      .from("messaging_channels")
      .select("id")
      .eq("platform", "telegram")

    if (chErr) throw chErr

    const channelIds = (channelRows ?? []).map((c) => c.id)
    if (!channelIds.length) {
      return NextResponse.json({ conversations: [], total: 0 })
    }

    const { data: groups, error: grpErr } = await supabaseAdmin
      .from("messaging_groups")
      .select("id, group_name, account_id, contact_id, lead_id, last_message_at, unread_count, pinned")
      .in("channel_id", channelIds)
      .eq("is_active", true)
      .order("pinned", { ascending: false })
      .order("last_message_at", { ascending: false })
      .limit(200)

    if (grpErr) throw grpErr
    if (!groups?.length) {
      return NextResponse.json({ conversations: [], total: 0 })
    }

    const groupIds = groups.map((g) => g.id)

    const { data: recentMsgs } = await supabaseAdmin
      .from("messages")
      .select("group_id, content_text, direction, created_at")
      .in("group_id", groupIds)
      .order("created_at", { ascending: false })
      .limit(500)

    const previewMap = new Map<string, { content_text: string | null; direction: string | null }>()
    for (const msg of recentMsgs ?? []) {
      if (!previewMap.has(msg.group_id)) {
        previewMap.set(msg.group_id, { content_text: msg.content_text, direction: msg.direction })
      }
    }

    const conversations: InboxConversation[] = groups.map((group) => {
      const preview = previewMap.get(group.id)
      return {
        id: `telegram:${group.id}`,
        channel: "telegram" as const,
        name: group.group_name ?? "Unknown",
        preview: preview?.content_text ?? "",
        lastMessageAt: group.last_message_at ?? new Date(0).toISOString(),
        unread: group.unread_count ?? 0,
        accountId: group.account_id ?? null,
        contactId: group.contact_id ?? null,
        starred: group.pinned ?? false,
      }
    })

    return NextResponse.json({ conversations, total: conversations.length })
  } catch (error) {
    console.error("Telegram conversations error:", error)
    return NextResponse.json({ error: "Failed to fetch Telegram conversations" }, { status: 500 })
  }
}
