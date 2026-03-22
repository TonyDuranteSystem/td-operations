import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailGet, getHeader, type GmailAPIMessage } from "@/lib/gmail"
import type { InboxConversation } from "@/lib/types"

export const dynamic = "force-dynamic"

// Extract email address from "Name <email>" format
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return (match ? match[1] : from).toLowerCase().trim()
}

// Build email→account lookup map
async function buildEmailLookup(): Promise<
  Map<string, { accountId: string; accountName: string }>
> {
  const lookup = new Map<string, { accountId: string; accountName: string }>()

  const { data: rows } = await supabaseAdmin
    .from("account_contacts")
    .select("account_id, account:accounts(company_name), contact:contacts(email, email_2)")

  if (!rows) return lookup

  for (const row of rows) {
    const acct = row.account as unknown as { company_name: string } | null
    const contact = row.contact as unknown as { email: string | null; email_2: string | null } | null
    if (!acct || !contact) continue

    const entry = { accountId: row.account_id, accountName: acct.company_name }
    if (contact.email) lookup.set(contact.email.toLowerCase(), entry)
    if (contact.email_2) lookup.set(contact.email_2.toLowerCase(), entry)
  }

  return lookup
}

export async function GET(req: NextRequest) {
  try {
    const channel = req.nextUrl.searchParams.get("channel") // whatsapp | telegram | gmail | null (all)
    const searchQuery = req.nextUrl.searchParams.get("q") // Gmail search query
    const labelFilter = req.nextUrl.searchParams.get("label") // Gmail label ID filter
    const pageToken = req.nextUrl.searchParams.get("pageToken") // Gmail pagination
    const mailbox = req.nextUrl.searchParams.get("mailbox") // support | antonio | null (support default)
    const limit = Math.min(
      parseInt(req.nextUrl.searchParams.get("limit") || "50"),
      200
    )

    const conversations: InboxConversation[] = []
    let gmailNextPageToken: string | undefined

    // Start email lookup in parallel (used later for Gmail matching)
    const emailLookupPromise =
      !channel || channel === "gmail" ? buildEmailLookup() : Promise.resolve(new Map())

    // ─── WhatsApp + Telegram from Supabase view ──────────
    if (!channel || channel === "whatsapp" || channel === "telegram") {
      let q = supabaseAdmin
        .from("v_messaging_inbox")
        .select(
          "group_id, group_name, unread_count, last_message_at, platform, last_message_preview, last_message_sender, account_name, contact_name"
        )
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(limit)

      // Filter by platform field directly from the view
      if (channel === "whatsapp") {
        q = q.eq("platform", "whatsapp")
      } else if (channel === "telegram") {
        q = q.eq("platform", "telegram")
      }

      const { data: groups, error } = await q

      if (error) throw error

      for (const g of groups || []) {
        conversations.push({
          id: g.group_id,
          channel: g.platform === "telegram" ? "telegram" : "whatsapp",
          name: g.group_name || g.contact_name || g.account_name || "Unknown",
          preview: g.last_message_preview
            ? `${g.last_message_sender ? g.last_message_sender + ": " : ""}${g.last_message_preview}`
            : "",
          unread: g.unread_count || 0,
          lastMessageAt: g.last_message_at || "",
        })
      }
    }

    // ─── Gmail threads ──────────────────────────────────
    if (!channel || channel === "gmail") {
      try {
        const gmailLimit = channel === "gmail" ? limit : Math.min(limit, 50)

        // Build Gmail query params
        const gmailParams: Record<string, string> = {
          maxResults: String(gmailLimit),
        }

        // Label filter: INBOX (default), SENT, DRAFT, STARRED, TRASH, or custom label ID
        if (labelFilter) {
          gmailParams.labelIds = labelFilter
        } else if (!searchQuery) {
          gmailParams.labelIds = "INBOX"
        }

        // Search query (Gmail search syntax)
        if (searchQuery) {
          gmailParams.q = searchQuery
        }

        // Pagination
        if (pageToken) {
          gmailParams.pageToken = pageToken
        }

        // Determine which mailbox to read
        const gmailUser = mailbox === 'antonio'
          ? 'antonio.durante@tonydurante.us'
          : 'support@tonydurante.us'

        const listResult = (await gmailGet("/threads", gmailParams, gmailUser)) as {
          threads?: Array<{ id: string; snippet: string; historyId: string }>
          nextPageToken?: string
        }

        gmailNextPageToken = listResult.nextPageToken

        // Wait for email lookup to complete
        const emailLookup = await emailLookupPromise

        if (listResult.threads) {
          // Fetch metadata for each thread (first message)
          const threadDetails = await Promise.allSettled(
            listResult.threads.slice(0, gmailLimit).map((t) =>
              gmailGet(`/threads/${t.id}`, {
                format: "metadata",
                metadataHeaders: ["From", "Subject", "Date"],
              }, gmailUser) as Promise<{
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
            // Count ALL unread messages in the thread (not just last)
            const unreadCount = thread.messages.filter(m => m.labelIds?.includes("UNREAD")).length
            const isUnread = unreadCount > 0
            // Check for attachments (multipart/mixed = has attachments)
            const hasAttachment = thread.messages.some(m =>
              m.payload?.mimeType === 'multipart/mixed' ||
              m.payload?.mimeType === 'multipart/related'
            )

            // Match sender email to CRM account
            const senderEmail = extractEmail(from)
            const accountMatch = emailLookup.get(senderEmail)

            conversations.push({
              id: `gmail:${thread.id}`,
              channel: "gmail",
              name: from.replace(/<.*>/, "").trim() || from,
              preview: firstMsg?.snippet || "",
              unread: unreadCount,
              lastMessageAt: lastDate
                ? new Date(lastDate).toISOString()
                : new Date(
                    parseInt(lastMsg?.internalDate || "0")
                  ).toISOString(),
              subject,
              accountId: accountMatch?.accountId ?? null,
              accountName: accountMatch?.accountName ?? null,
              hasAttachment,
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
      ...(gmailNextPageToken ? { nextPageToken: gmailNextPageToken } : {}),
    })
  } catch (error) {
    console.error("Inbox conversations error:", error)
    return NextResponse.json(
      { error: "Failed to fetch conversations" },
      { status: 500 }
    )
  }
}
