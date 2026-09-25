import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { InboxConversation } from "@/lib/types"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { resolveChatName } from "@/lib/messaging/chat-name"

export const dynamic = "force-dynamic"

export async function GET() {
  // Staff gate — middleware only guarantees "is logged in" for /api routes,
  // and a portal CLIENT has a login (2026-07-21 invariant; council find 2026-07-29,
  // dev job 7e63fcd2).
  const denied = await requireStaffRoute()
  if (denied) return denied

  try {
    // Step 1: get all WhatsApp channel IDs
    const { data: channelRows, error: chErr } = await supabaseAdmin
      .from("messaging_channels")
      .select("id")
      .eq("platform", "whatsapp")

    if (chErr) throw chErr

    const channelIds = (channelRows ?? []).map((c) => c.id)
    if (!channelIds.length) {
      return NextResponse.json({ conversations: [], total: 0 })
    }

    // Step 2: get messaging groups for those channels. Deleted (is_active =
    // false) groups are excluded — a WhatsApp "Delete" is a hide, not an
    // erase (lib/messaging plumbing and the messages themselves are
    // untouched; see /api/inbox/whatsapp/delete). Pinned rows sort first,
    // matching the Gmail list's own pinned-first behavior.
    const { data: groups, error: grpErr } = await supabaseAdmin
      .from("messaging_groups")
      .select(
        "id, group_name, external_group_id, account_id, contact_id, lead_id, last_message_at, unread_count, pinned"
      )
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

    // Names of the linked CRM records, read live — the CRM is the source of truth for people it knows, so
    // renaming a contact/lead there renames the chat here (lib/messaging/chat-name.ts). A chat with no link
    // falls back to the name saved on the phone, then to the formatted number — never "Unknown".
    const uniq = (xs: Array<string | null>) => Array.from(new Set(xs.filter((x): x is string => !!x)))
    const contactIds = uniq(groups.map((g) => g.contact_id))
    const leadIds = uniq(groups.map((g) => g.lead_id))
    const accountIds = uniq(groups.map((g) => g.account_id))
    const [contactRows, leadRows, accountRows] = await Promise.all([
      contactIds.length ? supabaseAdmin.from("contacts").select("id, full_name").in("id", contactIds) : Promise.resolve({ data: [] }),
      leadIds.length ? supabaseAdmin.from("leads").select("id, full_name").in("id", leadIds) : Promise.resolve({ data: [] }),
      accountIds.length ? supabaseAdmin.from("accounts").select("id, company_name").in("id", accountIds) : Promise.resolve({ data: [] }),
    ])
    const contactNames = new Map((contactRows.data ?? []).map((r) => [r.id, r.full_name as string | null]))
    const leadNames = new Map((leadRows.data ?? []).map((r) => [r.id, r.full_name as string | null]))
    const accountNames = new Map((accountRows.data ?? []).map((r) => [r.id, r.company_name as string | null]))

    // Step 3: get latest message preview per group
    // Fetch the most recent messages and pick first per group client-side
    const { data: recentMsgs } = await supabaseAdmin
      .from("messages")
      .select("group_id, content_text, direction, created_at")
      .in("group_id", groupIds)
      .order("created_at", { ascending: false })
      .limit(500)

    const previewMap = new Map<
      string,
      { content_text: string | null; direction: string | null }
    >()
    for (const msg of recentMsgs ?? []) {
      if (!previewMap.has(msg.group_id)) {
        previewMap.set(msg.group_id, {
          content_text: msg.content_text,
          direction: msg.direction,
        })
      }
    }

    const conversations: InboxConversation[] = groups.map((group) => {
      const preview = previewMap.get(group.id)
      return {
        id: `whatsapp:${group.id}`,
        channel: "whatsapp" as const,
        name: resolveChatName({
          contactName: group.contact_id ? contactNames.get(group.contact_id) : null,
          leadName: group.lead_id ? leadNames.get(group.lead_id) : null,
          accountName: group.account_id ? accountNames.get(group.account_id) : null,
          savedName: group.group_name,
          externalGroupId: group.external_group_id,
        }),
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
    console.error("WhatsApp conversations error:", error)
    return NextResponse.json(
      { error: "Failed to fetch WhatsApp conversations" },
      { status: 500 }
    )
  }
}
