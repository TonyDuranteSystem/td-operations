import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailGet, getHeader, type GmailAPIMessage } from "@/lib/gmail"
import {
  bucketUnreadEmails,
  extractEmailAddress,
  type ContactEmailRow,
} from "@/lib/inbox/email-unread"
import { isBackfillDone, unreadInboxExternalEmails } from "@/lib/email-index/query"

export const dynamic = "force-dynamic"

const OUR_EMAILS = new Set([
  "support@tonydurante.us",
  "antonio.durante@tonydurante.us",
])

/**
 * GET /api/portal-chats/email-unread
 *
 * Drives the GREEN dot in the Portal Chats client list: unread-email-thread
 * counts per account/contact, same bucket shape as the What's New counts.
 * Source of truth is Gmail's UNREAD state in support@ — reading the email
 * (Email tab or Gmail itself) clears the dot with no extra bookkeeping.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  try {
    // 1+2. External addresses per unread-inbox thread in support@ — from the
    // email index when its backfill is complete (one Postgres query instead
    // of 1+N Gmail calls per poll), live Gmail otherwise / on index errors.
    let threadExternalEmails: Array<Set<string>> | null = null
    try {
      if (await isBackfillDone("support")) {
        threadExternalEmails = await unreadInboxExternalEmails()
      }
    } catch (err) {
      console.warn("email-unread index path failed, falling back to live:", err)
    }

    if (threadExternalEmails === null) {
      const listResult = (await gmailGet("/threads", {
        q: "in:inbox is:unread",
        maxResults: "100",
      })) as { threads?: Array<{ id: string }> }

      const threadIds = (listResult.threads ?? []).map((t) => t.id)
      if (threadIds.length === 0) {
        return NextResponse.json({ by_account: {}, by_contact: {} })
      }

      const details = await Promise.allSettled(
        threadIds.map(
          (tid) =>
            gmailGet(`/threads/${tid}`, {
              format: "metadata",
              metadataHeaders: ["From", "To"],
            }) as Promise<{ messages: GmailAPIMessage[] }>
        )
      )

      threadExternalEmails = []
      for (const result of details) {
        if (result.status !== "fulfilled") continue
        const externals = new Set<string>()
        for (const msg of result.value.messages ?? []) {
          const from = getHeader(msg.payload?.headers, "From")
          if (from) {
            const addr = extractEmailAddress(from)
            if (addr && !OUR_EMAILS.has(addr)) externals.add(addr)
          }
          const to = getHeader(msg.payload?.headers, "To")
          for (const recipient of to ? to.split(",") : []) {
            const addr = extractEmailAddress(recipient)
            if (addr && !OUR_EMAILS.has(addr)) externals.add(addr)
          }
        }
        if (externals.size > 0) threadExternalEmails.push(externals)
      }
    }

    if (threadExternalEmails.length === 0) {
      return NextResponse.json({ by_account: {}, by_contact: {} })
    }

    // 3. CRM contact emails (account-linked + accountless contacts)
    const [{ data: acRows }, { data: contacts }] = await Promise.all([
      supabaseAdmin.from("account_contacts").select("account_id, contact_id"),
      supabaseAdmin
        .from("contacts")
        .select("id, email, email_2")
        .or("email.not.is.null,email_2.not.is.null"),
    ])

    const accountsByContact = new Map<string, string[]>()
    for (const row of acRows ?? []) {
      const list = accountsByContact.get(row.contact_id) ?? []
      list.push(row.account_id)
      accountsByContact.set(row.contact_id, list)
    }

    const contactRows: ContactEmailRow[] = []
    for (const c of contacts ?? []) {
      const accountIds = accountsByContact.get(c.id) ?? [null]
      for (const account_id of accountIds) {
        contactRows.push({
          contact_id: c.id,
          account_id,
          email: c.email,
          email_2: c.email_2,
        })
      }
    }

    return NextResponse.json(bucketUnreadEmails(threadExternalEmails, contactRows))
  } catch (error) {
    console.error("email-unread error:", error)
    // The dot is cosmetic — return empty buckets rather than erroring the page
    return NextResponse.json({ by_account: {}, by_contact: {} })
  }
}
