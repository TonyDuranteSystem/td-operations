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
    const channel = req.nextUrl.searchParams.get("channel") // gmail | portal | null (all)
    const searchQuery = req.nextUrl.searchParams.get("q") // Gmail search query
    const labelFilter = req.nextUrl.searchParams.get("label") // Gmail label ID filter
    const pageToken = req.nextUrl.searchParams.get("pageToken") // Gmail pagination
    const mailbox = req.nextUrl.searchParams.get("mailbox") // support | antonio | null (support default)
    const limit = Math.min(
      parseInt(req.nextUrl.searchParams.get("limit") || "50"),
      500
    )

    const conversations: InboxConversation[] = []
    let gmailNextPageToken: string | undefined

    // Start email lookup in parallel (used later for Gmail matching)
    const emailLookupPromise =
      !channel || channel === "gmail" ? buildEmailLookup() : Promise.resolve(new Map())

    // ─── Gmail threads ──────────────────────────────────
    if (!channel || channel === "gmail") {
      try {
        // Gmail threads API returns max ~100 per page. Fetch up to 2 pages (200 threads).
        // With INBOX as default, this is more than enough (Gmail inbox has ~20-50 threads).
        // For other labels or search queries, 200 threads covers most use cases.
        const targetGmailThreads = 200

        // Build Gmail query params
        const gmailParams: Record<string, string> = {
          maxResults: '100', // Gmail API max per request
        }

        // Label filter: INBOX (default), SENT, DRAFT, STARRED, TRASH, or custom label ID
        if (labelFilter) {
          if (labelFilter === 'TRASH') {
            // When viewing Trash, use label filter directly
            gmailParams.labelIds = labelFilter
          } else {
            // Use q parameter instead of labelIds — it reflects label changes faster
            // after modify operations (labelIds index can be stale for 30+ seconds)
            gmailParams.q = `in:${labelFilter.toLowerCase()} -in:trash`
          }
        } else if (searchQuery) {
          // Search with no label filter: search ALL mail (not just inbox)
          gmailParams.q = `${searchQuery} -in:trash -in:spam`
        } else {
          // Default (no label, no search): show INBOX — matches what Gmail UI shows.
          // Previously used 'newer_than:30d' which returned 3000+ threads,
          // making it impossible to show all emails even with pagination.
          gmailParams.labelIds = 'INBOX'
        }

        // Pagination
        if (pageToken) {
          gmailParams.pageToken = pageToken
        }

        // Determine which mailbox to read
        const gmailUser = mailbox === 'antonio'
          ? 'antonio.durante@tonydurante.us'
          : 'support@tonydurante.us'

        // Fetch multiple pages of threads to get enough results
        const allThreadIds: Array<{ id: string; snippet: string }> = []
        let currentPageToken = pageToken || undefined

        for (let page = 0; page < 2 && allThreadIds.length < targetGmailThreads; page++) {
          const pageParams = { ...gmailParams }
          if (currentPageToken) pageParams.pageToken = currentPageToken

          const listResult = (await gmailGet("/threads", pageParams, gmailUser)) as {
            threads?: Array<{ id: string; snippet: string; historyId: string }>
            nextPageToken?: string
          }

          if (listResult.threads) {
            allThreadIds.push(...listResult.threads)
          }

          gmailNextPageToken = listResult.nextPageToken
          currentPageToken = listResult.nextPageToken

          // No more pages
          if (!listResult.nextPageToken) break
        }

        // Wait for email lookup to complete
        const emailLookup = await emailLookupPromise

        if (allThreadIds.length > 0) {
          // Fetch metadata for each thread — limit to 300 to balance completeness vs speed
          const threadsToFetch = allThreadIds.slice(0, 300)
          const threadDetails = await Promise.allSettled(
            threadsToFetch.map((t) =>
              gmailGet(`/threads/${t.id}`, {
                format: "metadata",
                metadataHeaders: ["From", "To", "Subject", "Date"],
              }, gmailUser) as Promise<{
                id: string
                messages: GmailAPIMessage[]
              }>
            )
          )

          // Our own mailbox addresses — used to find external party
          const OUR_EMAILS = new Set(['support@tonydurante.us', 'antonio.durante@tonydurante.us'])

          for (const result of threadDetails) {
            if (result.status !== "fulfilled") continue
            const thread = result.value
            const firstMsg = thread.messages[0]
            const lastMsg = thread.messages[thread.messages.length - 1]

            const subject = getHeader(firstMsg?.payload?.headers, "Subject")
            const lastDate = getHeader(lastMsg?.payload?.headers, "Date")

            // Detect if this is a draft-only thread (all messages are drafts)
            const isDraftThread = thread.messages.every(m => m.labelIds?.includes("DRAFT"))

            // Find the external party (not us)
            let externalFrom = ''
            let externalEmail = ''

            // For draft threads, check To: FIRST — the recipient is the relevant party
            // For regular threads, check From first (external sender)
            if (isDraftThread) {
              for (const msg of thread.messages) {
                const toHeader = getHeader(msg?.payload?.headers, "To")
                if (toHeader) {
                  const recipients = toHeader.split(',')
                  for (const recipient of recipients) {
                    const recEmail = extractEmail(recipient.trim())
                    if (!OUR_EMAILS.has(recEmail)) {
                      externalFrom = recipient.trim()
                      externalEmail = recEmail
                      break
                    }
                  }
                  if (externalFrom) break
                }
              }
            } else {
              // Regular thread: find external sender first
              for (const msg of thread.messages) {
                const msgFrom = getHeader(msg?.payload?.headers, "From")
                const msgEmail = extractEmail(msgFrom)
                if (!OUR_EMAILS.has(msgEmail)) {
                  externalFrom = msgFrom
                  externalEmail = msgEmail
                  break
                }
              }
              // If all messages are from us (outbound thread), check To headers
              if (!externalFrom) {
                for (const msg of thread.messages) {
                  const toHeader = getHeader(msg?.payload?.headers, "To")
                  if (toHeader) {
                    const recipients = toHeader.split(',')
                    for (const recipient of recipients) {
                      const recEmail = extractEmail(recipient.trim())
                      if (!OUR_EMAILS.has(recEmail)) {
                        externalFrom = recipient.trim()
                        externalEmail = recEmail
                        break
                      }
                    }
                    if (externalFrom) break
                  }
                }
              }
            }
            // Final fallback: first message From (only useful for non-draft threads)
            if (!externalFrom) {
              externalFrom = getHeader(firstMsg?.payload?.headers, "From")
              externalEmail = extractEmail(externalFrom)
            }

            // Count ALL unread messages in the thread (not just last)
            const unreadCount = thread.messages.filter(m => m.labelIds?.includes("UNREAD")).length
            // Check for attachments (multipart/mixed = has attachments)
            const hasAttachment = thread.messages.some(m =>
              m.payload?.mimeType === 'multipart/mixed' ||
              m.payload?.mimeType === 'multipart/related'
            )

            // Match external email to CRM account
            const accountMatch = emailLookup.get(externalEmail)

            // Determine display name: CRM account name > From display name > email
            let displayName = externalFrom.replace(/<.*>/, "").trim()
            // If display name is just the email (no name part), try CRM lookup
            if (!displayName || displayName === externalEmail) {
              displayName = accountMatch?.accountName || externalEmail
            }

            // Use latest message snippet as preview (not first message)
            const latestSnippet = lastMsg?.snippet || firstMsg?.snippet || ""

            conversations.push({
              id: `gmail:${thread.id}`,
              channel: "gmail",
              name: displayName,
              preview: latestSnippet,
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
