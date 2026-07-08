import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailGet, getHeader, type GmailAPIMessage } from "@/lib/gmail"
import { decodeHtmlEntities, displayNameFromHeader } from "@/lib/inbox/email-html"
import { isSystemNotificationSubject } from "@/lib/inbox/system-email-filter"
import {
  isBackfillDone,
  clientEmailThreadIds,
  fetchThreadRows,
  groupRowsToConversations,
} from "@/lib/email-index/query"
import type { InboxConversation } from "@/lib/types"

const OUR_EMAILS = ["support@tonydurante.us", "antonio.durante@tonydurante.us"]

export const dynamic = "force-dynamic"

// email_links is not in the generated Database types yet. Same escape hatch
// as lib/system-errors.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/**
 * GET /api/portal-chats/client-emails?account_id=…|contact_id=…
 *
 * The client's email view (Portal Chats "Email" tab + account page "Emails"
 * tab): auto-matched Gmail correspondence in support@ (all mail to/from any
 * of the client's contact addresses) MERGED with manually linked threads
 * (`email_links` — e.g. a ShipStation or Mercury notification about this
 * client). Returns InboxConversation[] (linked threads flagged `linked`) so
 * the shipped inbox thread view renders them unchanged.
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

    // Manually linked threads for this client (support@ only in this view).
    // Account view also surfaces links made to the account's CONTACTS, so a
    // link lands regardless of which role it targeted.
    let linkQuery = db
      .from("email_links")
      .select("thread_id, mailbox")
      .eq("mailbox", "support")
    if (accountId) {
      // UUIDs unquoted — quoting inside or/in.() breaks PostgREST parsing
      // (QA 2026-07-08: the error was silently swallowed and links vanished)
      linkQuery = contactIds.length > 0
        ? linkQuery.or(`account_id.eq.${accountId},contact_id.in.(${contactIds.join(",")})`)
        : linkQuery.eq("account_id", accountId)
    } else {
      linkQuery = linkQuery.eq("contact_id", contactId)
    }
    const { data: linkRows, error: linkErr } = await linkQuery.limit(100)
    if (linkErr) console.error("client-emails link query failed:", linkErr.message)
    const linkedIds = new Set<string>(
      ((linkRows ?? []) as Array<{ thread_id: string }>).map((l) => l.thread_id)
    )

    if (emails.length === 0 && linkedIds.size === 0) {
      return NextResponse.json({ conversations: [], emails: [] })
    }

    // 2a. INDEX PATH (leg 2): complete any-age history from email_index,
    // no live Gmail round trips. Gated on backfill completion; any index
    // error falls back to the live path below — never worse than before.
    try {
      if (await isBackfillDone("support")) {
        const autoIds = await clientEmailThreadIds(emails)
        const autoSet = new Set(autoIds)
        const allIds = [
          ...autoIds,
          ...Array.from(linkedIds).filter((id) => !autoSet.has(id)),
        ]
        const rows = await fetchThreadRows("support", allIds)
        const conversations = groupRowsToConversations(rows, {
          linkedThreadIds: linkedIds,
        }).filter(
          // Same noise rule as the live path: our automated portal
          // notifications stay hidden unless deliberately linked.
          (c) => c.linked || !isSystemNotificationSubject(c.subject ?? "")
        )
        return NextResponse.json({ conversations, emails })
      }
    } catch (err) {
      console.warn("client-emails index path failed, falling back to live:", err)
    }

    // 2b. LIVE PATH — all mail to/from any of those addresses (support@)
    let autoIds: string[] = []
    if (emails.length > 0) {
      const clause = emails.map((e) => `from:${e} OR to:${e}`).join(" OR ")
      const listResult = (await gmailGet("/threads", {
        q: `{${clause}} -in:trash -in:spam`,
        maxResults: "50",
      })) as { threads?: Array<{ id: string }> }
      autoIds = (listResult.threads ?? []).map((t) => t.id)
    }

    // Union: auto-matched + manually linked (dedup, linked-only appended)
    const autoSet = new Set(autoIds)
    const threadIds = [...autoIds, ...Array.from(linkedIds).filter((id) => !autoSet.has(id))]
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

      const subject = getHeader(firstMsg.payload?.headers, "Subject")
      // Our own automated notifications ("N new updates in your portal",
      // "New message from the Tony Durante team") drown the real
      // correspondence — hidden here unless deliberately linked. Full record
      // stays in Gmail and the main Inbox.
      if (isSystemNotificationSubject(subject) && !linkedIds.has(thread.id)) continue

      const lastFrom = getHeader(lastMsg.payload?.headers, "From").toLowerCase()
      const lastDate = getHeader(lastMsg.payload?.headers, "Date")
      conversations.push({
        id: `gmail:${thread.id}`,
        channel: "gmail",
        name: displayNameFromHeader(getHeader(firstMsg.payload?.headers, "From")),
        preview: decodeHtmlEntities(lastMsg.snippet || firstMsg.snippet || ""),
        direction: OUR_EMAILS.some((e) => lastFrom.includes(e)) ? "sent" : "received",
        unread: thread.messages.filter((m) => m.labelIds?.includes("UNREAD")).length,
        lastMessageAt: lastDate
          ? new Date(lastDate).toISOString()
          : new Date(parseInt(lastMsg.internalDate || "0")).toISOString(),
        subject,
        hasAttachment: thread.messages.some(
          (m) =>
            m.payload?.mimeType === "multipart/mixed" ||
            m.payload?.mimeType === "multipart/related"
        ),
        linked: linkedIds.has(thread.id),
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
