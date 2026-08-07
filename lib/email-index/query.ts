/**
 * EMAIL INDEX — query layer (dev_task 224726be, leg 2).
 *
 * Serves the three index-first surfaces:
 *  (a) inbox instant search (plain-word queries → tsvector; Gmail-operator
 *      queries stay on live Gmail),
 *  (b) client email cards (per-client correspondence without live Gmail
 *      round trips),
 *  (c) green-dot unread buckets.
 *
 * Every surface is gated on `isBackfillDone` — while the (re)build runs,
 * callers fall back to the live-Gmail paths, so a partial index is never
 * presented as complete.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { markFromLabelNames } from "@/lib/inbox/color-marks"
import type { InboxConversation } from "@/lib/types"

// email_index is not in the generated Database types yet (regenerate after
// prod DDL). Same escape hatch as lib/email-index/sync.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export const OUR_MAILBOX_ADDRESSES = new Set([
  "support@tonydurante.us",
  "antonio.durante@tonydurante.us",
])

export interface EmailIndexRow {
  thread_id: string
  message_id: string
  mailbox: string
  from_email: string | null
  from_name: string | null
  to_emails: string[]
  subject: string | null
  snippet: string | null
  internal_date: string | null
  is_unread: boolean
  has_attachment: boolean
  label_ids: string[]
}

/**
 * True when the search box content is a plain-word query the local index can
 * answer. Gmail operator syntax (from:, has:attachment, in:sent, …) keeps
 * the full live-Gmail behavior.
 */
export function isInstantSearchQuery(q: string): boolean {
  const trimmed = q.trim()
  if (!trimmed) return false
  if (/[{}()]/.test(trimmed)) return false // grouped Gmail syntax
  return !/(^|\s)-?(from|to|cc|bcc|subject|has|in|is|label|filename|after|before|newer_than|older_than|deliveredto|list|rfc822msgid|larger|smaller|category):/i.test(
    trimmed
  )
}

/**
 * Pure: group index rows (any order) into InboxConversation[] with the SAME
 * semantics as the live conversations mapping in
 * app/api/inbox/conversations/route.ts — external-party resolution (drafts
 * look at To first), unread counts, attachment flag, Marked/* color
 * resolution via the caller-provided labelId→name map, display-name
 * fallback via the caller-provided email→account lookup.
 */
export function groupRowsToConversations(
  rows: EmailIndexRow[],
  opts: {
    markLabelNames?: Map<string, string>
    /** lowercased email → account (conversations route buildEmailLookup) */
    emailLookup?: Map<string, { accountId?: string; accountName?: string }>
    linkedThreadIds?: Set<string>
  } = {}
): InboxConversation[] {
  const byThread = new Map<string, EmailIndexRow[]>()
  for (const row of rows) {
    const list = byThread.get(row.thread_id) ?? []
    list.push(row)
    byThread.set(row.thread_id, list)
  }

  const conversations: InboxConversation[] = []
  // (forEach, not for..of — the TS target forbids Map iteration)
  byThread.forEach((threadRows, threadId) => {
    threadRows.sort(
      (a, b) =>
        new Date(a.internal_date ?? 0).getTime() - new Date(b.internal_date ?? 0).getTime()
    )
    // A thread whose every message is trashed is gone from every surface
    const live = threadRows.filter((r) => !r.label_ids.includes("TRASH"))
    if (live.length === 0) return

    const first = live[0]
    const last = live[live.length - 1]
    const isDraftThread = live.every((r) => r.label_ids.includes("DRAFT"))

    // External party: sender first (recipients for draft threads / all-ours)
    let externalEmail = ""
    let externalName = ""
    const fromCandidates = isDraftThread ? [] : live
    for (const r of fromCandidates) {
      if (r.from_email && !OUR_MAILBOX_ADDRESSES.has(r.from_email)) {
        externalEmail = r.from_email
        externalName = r.from_name ?? ""
        break
      }
    }
    if (!externalEmail) {
      for (const r of live) {
        const recipient = r.to_emails.find((e) => !OUR_MAILBOX_ADDRESSES.has(e))
        if (recipient) {
          externalEmail = recipient
          break
        }
      }
    }
    if (!externalEmail) {
      externalEmail = first.from_email ?? ""
      externalName = first.from_name ?? ""
    }

    const accountMatch = opts.emailLookup?.get(externalEmail)
    let displayName = externalName
    if (!displayName || displayName === externalEmail) {
      displayName = accountMatch?.accountName || externalEmail
    }

    const markNames: string[] = []
    if (opts.markLabelNames) {
      for (const r of live) {
        for (const lid of r.label_ids) {
          const name = opts.markLabelNames.get(lid)
          if (name) markNames.push(name)
        }
      }
    }
    const colorMark = markFromLabelNames(markNames)

    const lastFrom = (last.from_email ?? "").toLowerCase()
    conversations.push({
      id: `gmail:${threadId}`,
      channel: "gmail",
      name: displayName,
      preview: last.snippet ?? first.snippet ?? "",
      direction: OUR_MAILBOX_ADDRESSES.has(lastFrom) ? "sent" : "received",
      unread: live.filter((r) => r.label_ids.includes("UNREAD")).length,
      lastMessageAt:
        last.internal_date ?? first.internal_date ?? new Date(0).toISOString(),
      subject: first.subject ?? undefined,
      accountId: accountMatch?.accountId ?? null,
      accountName: accountMatch?.accountName ?? null,
      hasAttachment: live.some((r) => r.has_attachment),
      colorMark: colorMark?.key ?? null,
      // Payload-derived Inbox membership — powers the "Archived" chip in folder
      // and all-mail-search views. NEVER derive that chip from client memory of
      // a click; a refetch would contradict it (council, 2026-08-07).
      inInbox: live.some((r) => r.label_ids.includes("INBOX")),
      // Pin == Gmail star (thread-level). Powers the pin toggles + the
      // pinned-first ordering's visual marker (dev job 76b521ea).
      starred: live.some((r) => r.label_ids.includes("STARRED")),
      ...(opts.linkedThreadIds?.has(threadId) ? { linked: true } : {}),
    })
  })

  conversations.sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  )
  return conversations
}

/** Whether a mailbox's index backfill has completed (leg-2 surfaces gate). */
export async function isBackfillDone(mailbox: "support" | "antonio"): Promise<boolean> {
  const { data } = await db
    .from("gmail_watch_state")
    .select("backfill_done")
    .eq("mailbox", mailbox)
    .maybeSingle()
  return data?.backfill_done === true
}

/** Fetch every index row of the given threads (for grouping). */
export async function fetchThreadRows(
  mailbox: "support" | "antonio",
  threadIds: string[]
): Promise<EmailIndexRow[]> {
  if (threadIds.length === 0) return []
  const { data, error } = await db
    .from("email_index")
    .select(
      "thread_id, message_id, mailbox, from_email, from_name, to_emails, subject, snippet, internal_date, is_unread, has_attachment, label_ids"
    )
    .eq("mailbox", mailbox)
    .in("thread_id", threadIds)
    .limit(2000)
  if (error) throw new Error(`email_index thread fetch failed: ${error.message}`)
  return (data ?? []) as EmailIndexRow[]
}

/**
 * Instant search: tsvector match → matched threads → all rows of those
 * threads (newest threads first).
 *
 * This reads OUR OWN index, not Gmail — so the old caps (50 threads out of a
 * 400-row pre-scan) protected nothing and simply hid old mail: searching for
 * something a year back returned nothing even though the row was stored
 * (Antonio 2026-08-02: "I want email from one year ago"). The pre-scan now
 * scales with what the caller actually wants, so a deep search reaches the
 * whole mailbox. Still bounded — an unbounded scan on a growing table is how
 * you turn instant search into a slow one.
 */
export async function searchIndexThreadIds(
  q: string,
  mailbox: "support" | "antonio",
  maxThreads = 200
): Promise<string[]> {
  // Rows-to-scan: a thread usually has several messages, so scan a multiple of
  // the threads wanted, with a floor for tiny requests and a sane hard ceiling.
  const scanRows = Math.min(Math.max(maxThreads * 8, 400), 5000)
  const { data, error } = await db
    .from("email_index")
    .select("thread_id, internal_date, label_ids")
    .eq("mailbox", mailbox)
    .textSearch("search", q, { type: "websearch", config: "simple" })
    .order("internal_date", { ascending: false })
    .limit(scanRows)
  if (error) throw new Error(`email_index search failed: ${error.message}`)

  const seen = new Set<string>()
  const ordered: string[] = []
  for (const row of (data ?? []) as Array<{ thread_id: string; label_ids: string[] }>) {
    if (row.label_ids.includes("TRASH") || row.label_ids.includes("SPAM")) continue
    if (seen.has(row.thread_id)) continue
    seen.add(row.thread_id)
    ordered.push(row.thread_id)
    if (ordered.length >= maxThreads) break
  }
  return ordered
}

/**
 * ONE PAGE of conversations — real page numbers (Antonio 2026-08-02: "in Gmail I
 * have the numbers of the pages 1,2,3,4,5 according to how many emails I have").
 *
 * Paging happens in the DB (`inbox_thread_page`), which collapses the index's
 * one-row-per-MESSAGE into one row per THREAD before applying LIMIT/OFFSET. A
 * plain offset over rows would split a conversation across two pages; this
 * cannot. `folder` is a Gmail label id (INBOX, SENT, a user folder).
 */
export async function pageIndexThreadIds(
  mailbox: "support" | "antonio",
  folder: string,
  pageSize: number,
  offset: number,
): Promise<string[]> {
  const { data, error } = await db.rpc("inbox_thread_page", {
    p_mailbox: mailbox, p_label: folder,
    p_limit: Math.max(1, pageSize), p_offset: Math.max(0, offset),
  })
  if (error) throw new Error(`inbox_thread_page failed: ${error.message}`)
  return ((data ?? []) as Array<{ thread_id: string }>).map((r) => r.thread_id)
}

/** Total conversations in a folder — the N in "page 1 of N". */
export async function countIndexThreads(
  mailbox: "support" | "antonio",
  folder: string,
): Promise<number> {
  const { data, error } = await db.rpc("inbox_thread_count", { p_mailbox: mailbox, p_label: folder })
  if (error) throw new Error(`inbox_thread_count failed: ${error.message}`)
  return Number(data ?? 0)
}

import type { SearchScope } from "@/lib/inbox/view-query"

/** ONE PAGE of SEARCH results as conversations (same thread-level paging). */
export async function pageSearchThreadIds(
  mailbox: "support" | "antonio",
  query: string,
  pageSize: number,
  offset: number,
  scope: SearchScope = "all",
): Promise<string[]> {
  const { data, error } = await db.rpc("inbox_search_thread_page", {
    p_mailbox: mailbox, p_query: query,
    p_limit: Math.max(1, pageSize), p_offset: Math.max(0, offset),
    p_scope: scope,
  })
  if (error) throw new Error(`inbox_search_thread_page failed: ${error.message}`)
  return ((data ?? []) as Array<{ thread_id: string }>).map((r) => r.thread_id)
}

/** Total conversations matching a search — the N in "page 1 of N". */
export async function countSearchThreads(
  mailbox: "support" | "antonio",
  query: string,
  scope: SearchScope = "all",
): Promise<number> {
  const { data, error } = await db.rpc("inbox_search_thread_count", {
    p_mailbox: mailbox, p_query: query, p_scope: scope,
  })
  if (error) throw new Error(`inbox_search_thread_count failed: ${error.message}`)
  return Number(data ?? 0)
}

/**
 * ONE PAGE of ARCHIVED conversations: out of the Inbox, not trashed / spam /
 * snoozed, not pure-sent / pure-draft — judged at THREAD level by the RPC.
 * Index-only by design: "archived" is a thread-level negation Gmail's query
 * language cannot express, so this view has NO live-Gmail fallback — callers
 * must gate on `isBackfillDone` and show an explicit unavailable state.
 * `excludeLabels`: per-mailbox label ids to treat as not-archived (the
 * "Snoozed" user label — belt to the email_snoozes braces inside the RPC).
 */
export async function pageArchivedThreadIds(
  mailbox: "support" | "antonio",
  pageSize: number,
  offset: number,
  excludeLabels: string[] = [],
): Promise<string[]> {
  const { data, error } = await db.rpc("inbox_archived_thread_page", {
    p_mailbox: mailbox,
    p_limit: Math.max(1, pageSize), p_offset: Math.max(0, offset),
    p_exclude_labels: excludeLabels,
  })
  if (error) throw new Error(`inbox_archived_thread_page failed: ${error.message}`)
  return ((data ?? []) as Array<{ thread_id: string }>).map((r) => r.thread_id)
}

/** Total archived conversations — the N in "page 1 of N" for Archived. */
export async function countArchivedThreads(
  mailbox: "support" | "antonio",
  excludeLabels: string[] = [],
): Promise<number> {
  const { data, error } = await db.rpc("inbox_archived_thread_count", {
    p_mailbox: mailbox, p_exclude_labels: excludeLabels,
  })
  if (error) throw new Error(`inbox_archived_thread_count failed: ${error.message}`)
  return Number(data ?? 0)
}

/**
 * BROWSE from our own index: newest thread ids carrying `labelId` (e.g. INBOX,
 * SENT, or a user folder), newest first.
 *
 * The browse list historically fetched every thread from LIVE Gmail — up to 300
 * calls per page. That is what made the inbox slow, capped, and fragile: on
 * 2026-08-02 it exhausted the per-user Gmail quota and every row rendered
 * "Couldn't load this email — retrying". Serving the list from the index we
 * already maintain removes the Gmail round-trips entirely, so browsing is a DB
 * query: instant, unbounded by Gmail quota, and safe under concurrent load.
 *
 * TRASH/SPAM are excluded unless explicitly asked for, mirroring the live path.
 */
export async function listIndexThreadIds(
  mailbox: "support" | "antonio",
  labelId: string,
  maxThreads = 100,
): Promise<string[]> {
  const scanRows = Math.min(Math.max(maxThreads * 8, 400), 5000)
  const { data, error } = await db
    .from("email_index")
    .select("thread_id, internal_date, label_ids")
    .eq("mailbox", mailbox)
    .contains("label_ids", [labelId])
    .order("internal_date", { ascending: false })
    .limit(scanRows)
  if (error) throw new Error(`email_index list failed: ${error.message}`)

  const excludeTrash = labelId !== "TRASH"
  const excludeSpam = labelId !== "SPAM"
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const row of (data ?? []) as Array<{ thread_id: string; label_ids: string[] }>) {
    if (excludeTrash && row.label_ids.includes("TRASH")) continue
    if (excludeSpam && row.label_ids.includes("SPAM")) continue
    if (seen.has(row.thread_id)) continue
    seen.add(row.thread_id)
    ordered.push(row.thread_id)
    if (ordered.length >= maxThreads) break
  }
  return ordered
}

/**
 * Thread ids of all support@ correspondence with any of the given client
 * addresses (from OR to). Two indexed queries — deliberately NOT a PostgREST
 * or(in.(),ov.{}) filter, whose value-quoting rules silently break
 * (2026-07-08 email_links QA precedent).
 */
export async function clientEmailThreadIds(
  emails: string[],
  maxThreads = 50
): Promise<string[]> {
  if (emails.length === 0) return []
  const [fromRes, toRes] = await Promise.all([
    db
      .from("email_index")
      .select("thread_id, internal_date")
      .eq("mailbox", "support")
      .in("from_email", emails)
      .order("internal_date", { ascending: false })
      .limit(500),
    db
      .from("email_index")
      .select("thread_id, internal_date")
      .eq("mailbox", "support")
      .overlaps("to_emails", emails)
      .order("internal_date", { ascending: false })
      .limit(500),
  ])
  if (fromRes.error) throw new Error(`email_index from query failed: ${fromRes.error.message}`)
  if (toRes.error) throw new Error(`email_index to query failed: ${toRes.error.message}`)

  const rows = [
    ...((fromRes.data ?? []) as Array<{ thread_id: string; internal_date: string | null }>),
    ...((toRes.data ?? []) as Array<{ thread_id: string; internal_date: string | null }>),
  ].sort(
    (a, b) => new Date(b.internal_date ?? 0).getTime() - new Date(a.internal_date ?? 0).getTime()
  )
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const row of rows) {
    if (seen.has(row.thread_id)) continue
    seen.add(row.thread_id)
    ordered.push(row.thread_id)
    if (ordered.length >= maxThreads) break
  }
  return ordered
}

/**
 * Green-dot feed: external addresses per unread-inbox thread in support@ —
 * parity with the live path (`in:inbox is:unread` thread list, then From+To
 * of EVERY message on each thread, so a CC'd second contact still buckets).
 */
export async function unreadInboxExternalEmails(): Promise<Array<Set<string>>> {
  const { data, error } = await db
    .from("email_index")
    .select("thread_id")
    .eq("mailbox", "support")
    .contains("label_ids", ["UNREAD", "INBOX"])
    .limit(1000)
  if (error) throw new Error(`email_index unread query failed: ${error.message}`)

  const threadIds = Array.from(
    new Set(((data ?? []) as Array<{ thread_id: string }>).map((r) => r.thread_id))
  ).slice(0, 100)
  if (threadIds.length === 0) return []

  const rows = await fetchThreadRows("support", threadIds)
  const byThread = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.label_ids.includes("TRASH")) continue
    const externals = byThread.get(row.thread_id) ?? new Set<string>()
    if (row.from_email && !OUR_MAILBOX_ADDRESSES.has(row.from_email)) {
      externals.add(row.from_email)
    }
    for (const addr of row.to_emails) {
      if (!OUR_MAILBOX_ADDRESSES.has(addr)) externals.add(addr)
    }
    byThread.set(row.thread_id, externals)
  }
  return Array.from(byThread.values()).filter((s) => s.size > 0)
}
