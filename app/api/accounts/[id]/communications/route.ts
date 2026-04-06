import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailGet, getHeader, type GmailAPIMessage } from "@/lib/gmail"
import type { InboxConversation } from "@/lib/types"

export const dynamic = "force-dynamic"

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const accountId = params.id

    // 1) Fetch contacts for this account (get their emails)
    const { data: junctions, error: jErr } = await supabaseAdmin
      .from("account_contacts")
      .select("contact:contacts(id, email, email_2)")
      .eq("account_id", accountId)

    if (jErr) throw jErr

    const emails = new Set<string>()
    for (const j of junctions || []) {
      const c = j.contact as unknown as { id: string; email: string | null; email_2: string | null }
      if (c?.email) emails.add(c.email.toLowerCase())
      if (c?.email_2) emails.add(c.email_2.toLowerCase())
    }

    const conversations: InboxConversation[] = []

    // 2) Fetch portal messages for this account
    const { data: portalMsgs, error: pErr } = await supabaseAdmin
      .from("portal_messages")
      .select("id, sender_type, message, created_at, read_at, contact:contacts(full_name)")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(50)

    if (!pErr && portalMsgs && portalMsgs.length > 0) {
      // Group portal messages as a single "conversation"
      const lastMsg = portalMsgs[0]
      const unreadCount = portalMsgs.filter(m => m.sender_type === "client" && !m.read_at).length
      const contactName = (lastMsg.contact as unknown as { full_name: string } | null)?.full_name || "Client"

      conversations.push({
        id: `portal:${accountId}`,
        channel: "portal",
        name: contactName,
        preview: lastMsg.message?.substring(0, 120) || "",
        unread: unreadCount,
        lastMessageAt: lastMsg.created_at || "",
        accountId,
      })
    }

    // 4) Fetch Gmail threads for each contact email
    if (emails.size > 0) {
      try {
        const emailArr = Array.from(emails)
        const queryParts = emailArr.flatMap((e) => [`from:${e}`, `to:${e}`])
        const q = queryParts.join(" OR ")

        const listResult = (await gmailGet("/threads", {
          maxResults: "30",
          q,
        })) as {
          threads?: Array<{ id: string; snippet: string }>
        }

        if (listResult.threads) {
          const threadDetails = await Promise.allSettled(
            listResult.threads.slice(0, 30).map((t) =>
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
              accountId,
            })
          }
        }
      } catch (gmailErr) {
        console.error("Gmail fetch error for account:", gmailErr)
        // Don't fail — just skip Gmail
      }
    }

    // Sort all by date desc
    conversations.sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() -
        new Date(a.lastMessageAt).getTime()
    )

    // Stats per channel
    const stats = {
      gmail: conversations.filter((c) => c.channel === "gmail").length,
      portal: conversations.filter((c) => c.channel === "portal").length,
      total: conversations.length,
    }

    return NextResponse.json({ conversations, stats })
  } catch (error) {
    console.error("Account communications error:", error)
    return NextResponse.json(
      { error: "Failed to fetch communications" },
      { status: 500 }
    )
  }
}
