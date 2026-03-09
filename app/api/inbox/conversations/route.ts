import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailGet, getHeader, type GmailAPIMessage } from "@/lib/gmail"
import type { InboxConversation } from "@/lib/types"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  try {
    const channel = req.nextUrl.searchParams.get("channel") // whatsapp | telegram | gmail | null (all)
    const limit = Math.min(
      parseInt(req.nextUrl.searchParams.get("limit") || "30"),
      100
    )

    const conversations: InboxConversation[] = []

    // ─── WhatsApp + Telegram from Supabase ──────────────
    if (!channel || channel === "whatsapp" || channel === "telegram") {
      let q = supabaseAdmin
        .from("v_messaging_inbox")
        .select(
          "id, group_name, last_message_at, last_message_preview, unread_count, account_id, contact_id, channel_id, messaging_channels(provider)"
        )
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(limit)

      if (channel === "whatsapp") {
        // Get WhatsApp channel IDs
        const { data: waCh } = await supabaseAdmin
          .from("messaging_channels")
          .select("id")
          .eq("provider", "WhatsApp")
        if (waCh?.length) {
          q = q.in(
            "channel_id",
            waCh.map((c: { id: string }) => c.id)
          )
        }
      } else if (channel === "telegram") {
        const { data: tgCh } = await supabaseAdmin
          .from("messaging_channels")
          .select("id")
          .eq("provider", "Telegram")
        if (tgCh?.length) {
          q = q.in(
            "channel_id",
            tgCh.map((c: { id: string }) => c.id)
          )
        }
      }

      const { data: groups, error } = await q

      if (error) throw error

      for (const g of groups || []) {
        const provider =
          (g as Record<string, unknown>).messaging_channels &&
          typeof (g as Record<string, unknown>).messaging_channels === "object"
            ? ((g as Record<string, unknown>).messaging_channels as { provider?: string })?.provider
            : null

        conversations.push({
          id: g.id,
          channel:
            provider === "Telegram"
              ? "telegram"
              : "whatsapp",
          name: g.group_name || "Unknown",
          preview: g.last_message_preview || "",
          unread: g.unread_count || 0,
          lastMessageAt: g.last_message_at || "",
          accountId: g.account_id,
          contactId: g.contact_id,
        })
      }
    }

    // ─── Gmail threads ──────────────────────────────────
    if (!channel || channel === "gmail") {
      try {
        const gmailLimit = channel === "gmail" ? limit : Math.min(limit, 20)
        const listResult = (await gmailGet("/threads", {
          maxResults: String(gmailLimit),
          labelIds: "INBOX",
        })) as {
          threads?: Array<{ id: string; snippet: string; historyId: string }>
        }

        if (listResult.threads) {
          // Fetch metadata for each thread (first message)
          const threadDetails = await Promise.allSettled(
            listResult.threads.slice(0, gmailLimit).map((t) =>
              gmailGet(`/threads/${t.id}`, {
                format: "metadata",
                metadataHeaders: ["From", "Subject", "Date"],
              }) as Promise<{
                id: string
                messages: GmailAPIMessage[]
              }>
            )
          )

          for (const result of threadDetails) {
            if (result.status !== "fulfilled") continue
            const thread = result.value
            const firstMsg = thread.messages[0]
            const lastMsg = thread.messages[thread.messages.length - 1]

            const from = getHeader(firstMsg?.payload?.headers, "From")
            const subject = getHeader(firstMsg?.payload?.headers, "Subject")
            const lastDate = getHeader(lastMsg?.payload?.headers, "Date")
            const isUnread = lastMsg?.labelIds?.includes("UNREAD") || false

            conversations.push({
              id: `gmail:${thread.id}`,
              channel: "gmail",
              name: from.replace(/<.*>/, "").trim() || from,
              preview: firstMsg?.snippet || "",
              unread: isUnread ? 1 : 0,
              lastMessageAt: lastDate
                ? new Date(lastDate).toISOString()
                : new Date(
                    parseInt(lastMsg?.internalDate || "0")
                  ).toISOString(),
              subject,
            })
          }
        }
      } catch (gmailErr) {
        console.error("Gmail fetch error:", gmailErr)
        // Don't fail the whole request — just skip Gmail
      }
    }

    // Sort all conversations by lastMessageAt desc
    conversations.sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() -
        new Date(a.lastMessageAt).getTime()
    )

    return NextResponse.json({
      conversations: conversations.slice(0, limit),
      total: conversations.length,
    })
  } catch (error) {
    console.error("Inbox conversations error:", error)
    return NextResponse.json(
      { error: "Failed to fetch conversations" },
      { status: 500 }
    )
  }
}
