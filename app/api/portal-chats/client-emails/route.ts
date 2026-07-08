import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailGet, getHeader, type GmailAPIMessage } from "@/lib/gmail"
import type { InboxConversation } from "@/lib/types"

export const dynamic = "force-dynamic"

/**
 * GET /api/portal-chats/client-emails?account_id=…|contact_id=…
 *
 * The "Email" tab in Portal Chats: this client's Gmail correspondence in
 * support@ (all mail to/from any of the client's contact addresses, newest
 * first). Returns InboxConversation[] so the shipped inbox thread view
 * (MessageThread + ComposeReply) renders them unchanged.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const accountId = req.nextUrl.searchParams.get("account_id")
  const contactId = req.nextUrl.searchParams.get("contact_id")
  if (!accountId && !contactId) {
    return NextResponse.json(
      { error: "account_id or contact_id is required" },
      { status: 400 }
    )
  }

  try {
    // 1. Resolve the client's email addresses
    let contactIds: string[] = contactId ? [contactId] : []
    if (accountId) {
      const { data: links } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id")
        .eq("account_id", accountId)
      contactIds = Array.from(
        new Set([...contactIds, ...(links ?? []).map((l) => l.contact_id)])
      )
    }
    if (contactIds.length === 0) {
      return NextResponse.json({ conversations: [], emails: [] })
    }

    const { data: contacts } = await supabaseAdmin
      .from("contacts")
      .select("email, email_2")
      .in("id", contactIds)

    const emails = Array.from(
      new Set(
        (contacts ?? [])
          .flatMap((c) => [c.email, c.email_2])
          .filter((e): e is string => !!e)
          .map((e) => e.toLowerCase().trim())
      )
    )
    if (emails.length === 0) {
      return NextResponse.json({ conversations: [], emails: [] })
    }

    // 2. All mail to/from any of those addresses (support@ mailbox)
    const clause = emails.map((e) => `from:${e} OR to:${e}`).join(" OR ")
    const listResult = (await gmailGet("/threads", {
      q: `{${clause}} -in:trash -in:spam`,
      maxResults: "50",
    })) as { threads?: Array<{ id: string }> }

    const threadIds = (listResult.threads ?? []).map((t) => t.id)
    if (threadIds.length === 0) {
      return NextResponse.json({ conversations: [], emails })
    }

    const details = await Promise.allSettled(
      threadIds.map(
        (tid) =>
          gmailGet(`/threads/${tid}`, {
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          }) as Promise<{ id: string; messages: GmailAPIMessage[] }>
      )
    )

    const conversations: InboxConversation[] = []
    for (const result of details) {
      if (result.status !== "fulfilled") continue
      const thread = result.value
      const firstMsg = thread.messages?.[0]
      const lastMsg = thread.messages?.[thread.messages.length - 1]
      if (!firstMsg || !lastMsg) continue

      const lastDate = getHeader(lastMsg.payload?.headers, "Date")
      conversations.push({
        id: `gmail:${thread.id}`,
        channel: "gmail",
        name: getHeader(firstMsg.payload?.headers, "From").replace(/<.*>/, "").trim(),
        preview: lastMsg.snippet || firstMsg.snippet || "",
        unread: thread.messages.filter((m) => m.labelIds?.includes("UNREAD")).length,
        lastMessageAt: lastDate
          ? new Date(lastDate).toISOString()
          : new Date(parseInt(lastMsg.internalDate || "0")).toISOString(),
        subject: getHeader(firstMsg.payload?.headers, "Subject"),
        hasAttachment: thread.messages.some(
          (m) =>
            m.payload?.mimeType === "multipart/mixed" ||
            m.payload?.mimeType === "multipart/related"
        ),
      })
    }

    conversations.sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
    )

    return NextResponse.json({ conversations, emails })
  } catch (error) {
    console.error("client-emails error:", error)
    return NextResponse.json(
      { error: "Failed to load client emails" },
      { status: 500 }
    )
  }
}
