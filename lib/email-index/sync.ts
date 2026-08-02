/**
 * EMAIL INDEX — sync engine (dev_task 224726be, leg 1).
 *
 * Keeps `email_index` (metadata-only, rebuildable) in step with Gmail:
 *  - `backfillStep(mailbox)`   — one resumable page of history (cron-driven;
 *    cursor in gmail_watch_state.backfill_page_token / backfill_done)
 *  - `syncIncremental(mailbox)`— history.list since the last indexed
 *    historyId (called from the gmail-push webhook, best-effort)
 *  - `indexThread(mailbox, threadId)` — upsert every message of one thread
 *
 * Gmail is the SOURCE OF TRUTH: rows are safe to wipe and rebuild. No
 * bodies, no attachments — headers, snippet, label state, CRM linkage only.
 */

import { gmailGet, getHeader, type GmailAPIMessage } from "@/lib/gmail"
import { withGmailRetry } from "@/lib/email-store/capture"
import { decodeHtmlEntities, displayNameFromHeader } from "@/lib/inbox/email-html"
import { extractEmailAddress } from "@/lib/inbox/email-unread"
import { supabaseAdmin } from "@/lib/supabase-admin"

// email_index / gmail_watch_state columns are not in the generated Database
// types yet (regenerated from production after the prod DDL). Same escape
// hatch as lib/system-errors.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export const MAILBOX_ADDRESSES: Record<"support" | "antonio", string> = {
  support: "support@tonydurante.us",
  antonio: "antonio.durante@tonydurante.us",
}

const OUR_ADDRESSES = new Set(Object.values(MAILBOX_ADDRESSES))

// ─── CRM linkage resolution ─────────────────────────────

export interface CrmDirectory {
  /** lowercased email → { contact_id, account_id } (first linked account) */
  contacts: Map<string, { contact_id: string; account_id: string | null }>
  /** lowercased email → lead_id */
  leads: Map<string, string>
}

/** Load the CRM email directory once per sync batch. */
export async function loadCrmDirectory(): Promise<CrmDirectory> {
  const [{ data: contacts }, { data: acRows }, { data: leads }] = await Promise.all([
    db.from("contacts").select("id, email, email_2"),
    db.from("account_contacts").select("account_id, contact_id"),
    db.from("leads").select("id, email"),
  ])

  const firstAccount = new Map<string, string>()
  for (const row of acRows ?? []) {
    if (!firstAccount.has(row.contact_id)) firstAccount.set(row.contact_id, row.account_id)
  }

  const contactMap = new Map<string, { contact_id: string; account_id: string | null }>()
  for (const c of contacts ?? []) {
    for (const raw of [c.email, c.email_2]) {
      const email = raw?.toLowerCase().trim()
      if (email && !contactMap.has(email)) {
        contactMap.set(email, { contact_id: c.id, account_id: firstAccount.get(c.id) ?? null })
      }
    }
  }

  const leadMap = new Map<string, string>()
  for (const l of leads ?? []) {
    const email = l.email?.toLowerCase().trim()
    if (email && !leadMap.has(email)) leadMap.set(email, l.id)
  }

  return { contacts: contactMap, leads: leadMap }
}

/** Pure: resolve CRM linkage from a message's external addresses. */
export function resolveLinkage(
  externalEmails: string[],
  dir: CrmDirectory
): { account_id: string | null; contact_id: string | null; lead_id: string | null } {
  for (const email of externalEmails) {
    const c = dir.contacts.get(email)
    if (c) return { account_id: c.account_id, contact_id: c.contact_id, lead_id: null }
  }
  for (const email of externalEmails) {
    const l = dir.leads.get(email)
    if (l) return { account_id: null, contact_id: null, lead_id: l }
  }
  return { account_id: null, contact_id: null, lead_id: null }
}

/** Pure: build one email_index row from a Gmail message (metadata format). */
export function buildIndexRow(
  mailbox: "support" | "antonio",
  msg: GmailAPIMessage,
  dir: CrmDirectory
) {
  const fromHeader = getHeader(msg.payload?.headers, "From")
  const toHeader = getHeader(msg.payload?.headers, "To")
  const fromEmail = extractEmailAddress(fromHeader)
  const toEmails = (toHeader ? toHeader.split(",") : [])
    .map((r) => extractEmailAddress(r))
    .filter(Boolean)

  const externals = [fromEmail, ...toEmails].filter((e) => e && !OUR_ADDRESSES.has(e))
  const linkage = resolveLinkage(externals, dir)

  return {
    mailbox,
    thread_id: msg.threadId,
    message_id: msg.id,
    from_email: fromEmail || null,
    from_name: displayNameFromHeader(fromHeader) || null,
    to_emails: toEmails,
    subject: getHeader(msg.payload?.headers, "Subject") || null,
    snippet: decodeHtmlEntities(msg.snippet || ""),
    internal_date: msg.internalDate
      ? new Date(parseInt(msg.internalDate)).toISOString()
      : null,
    is_unread: msg.labelIds?.includes("UNREAD") ?? false,
    label_ids: msg.labelIds ?? [],
    has_attachment:
      msg.payload?.mimeType === "multipart/mixed" ||
      msg.payload?.mimeType === "multipart/related",
    ...linkage,
    updated_at: new Date().toISOString(),
  }
}

// ─── Thread / batch indexing ────────────────────────────

const METADATA_PARAMS = {
  format: "metadata",
  metadataHeaders: ["From", "To", "Subject", "Date"],
} as const

/** Fetch one thread and upsert all its messages. */
export async function indexThread(
  mailbox: "support" | "antonio",
  threadId: string,
  dir: CrmDirectory
): Promise<number> {
  // Retry on 429/5xx: at backfill throughput a transient rate-limit must NOT
  // drop a thread (which would leave a permanent, undetectable gap in the index
  // that the content capture then can't even see). Non-retryable errors (404 for
  // a deleted thread) still throw — the caller records that as a failure.
  const thread = (await withGmailRetry(() =>
    gmailGet(
      `/threads/${threadId}`,
      METADATA_PARAMS as unknown as Record<string, string | string[]>,
      MAILBOX_ADDRESSES[mailbox]
    )
  )) as { messages?: GmailAPIMessage[] }

  const rows = (thread.messages ?? []).map((m) => buildIndexRow(mailbox, m, dir))
  if (rows.length === 0) return 0

  const { error } = await db
    .from("email_index")
    .upsert(rows, { onConflict: "mailbox,message_id" })
  if (error) throw new Error(`email_index upsert failed: ${error.message}`)
  return rows.length
}

// ─── Backfill (resumable, cron-driven) ──────────────────

/**
 * Process ONE page of the full-mailbox backfill (~100 threads). Returns
 * progress; the cron calls this repeatedly until `done`.
 */
export async function backfillStep(
  mailbox: "support" | "antonio",
  maxThreads = 60
): Promise<{ indexedThreads: number; indexedMessages: number; done: boolean }> {
  const { data: state } = await db
    .from("gmail_watch_state")
    .select("backfill_page_token, backfill_done")
    .eq("mailbox", mailbox)
    .maybeSingle()

  if (state?.backfill_done) return { indexedThreads: 0, indexedMessages: 0, done: true }

  const params: Record<string, string> = {
    maxResults: String(maxThreads),
    q: "-in:spam -in:trash",
  }
  if (state?.backfill_page_token) params.pageToken = state.backfill_page_token

  const list = (await gmailGet("/threads", params, MAILBOX_ADDRESSES[mailbox])) as {
    threads?: Array<{ id: string }>
    nextPageToken?: string
  }

  const dir = await loadCrmDirectory()
  let messages = 0
  const ids = (list.threads ?? []).map((t) => t.id)
  // Small parallel batches — keep Gmail rate limits comfortable
  for (let i = 0; i < ids.length; i += 8) {
    const results = await Promise.allSettled(
      ids.slice(i, i + 8).map((id) => indexThread(mailbox, id, dir))
    )
    for (const r of results) if (r.status === "fulfilled") messages += r.value
  }

  const done = !list.nextPageToken
  // UPSERT — the row may not exist yet (watch registration is prod-only;
  // sandbox builds its own index). Caught by the live sandbox backfill test.
  await db
    .from("gmail_watch_state")
    .upsert(
      {
        mailbox,
        email_address: MAILBOX_ADDRESSES[mailbox],
        backfill_page_token: list.nextPageToken ?? null,
        backfill_done: done,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "mailbox" }
    )

  return { indexedThreads: ids.length, indexedMessages: messages, done }
}

// ─── Incremental (gmail-push driven) ────────────────────

/**
 * Index everything that changed since the last indexed historyId.
 * Called (best-effort) from the gmail-push webhook. Handles the expired-
 * history case by resetting the cursor (backfill/nightly heals the gap).
 */
export async function syncIncremental(
  mailbox: "support" | "antonio",
  latestHistoryId: string
): Promise<{ threads: number }> {
  const { data: state } = await db
    .from("gmail_watch_state")
    .select("index_history_id")
    .eq("mailbox", mailbox)
    .maybeSingle()

  const since = state?.index_history_id
  const threadIds = new Set<string>()

  if (since) {
    try {
      let pageToken: string | undefined
      do {
        const params: Record<string, string> = { startHistoryId: since, maxResults: "100" }
        if (pageToken) params.pageToken = pageToken
        const hist = (await gmailGet("/history", params, MAILBOX_ADDRESSES[mailbox])) as {
          history?: Array<{
            messages?: Array<{ threadId?: string }>
            messagesAdded?: Array<{ message?: { threadId?: string } }>
            labelsAdded?: Array<{ message?: { threadId?: string } }>
            labelsRemoved?: Array<{ message?: { threadId?: string } }>
          }>
          nextPageToken?: string
        }
        for (const h of hist.history ?? []) {
          for (const m of h.messages ?? []) if (m.threadId) threadIds.add(m.threadId)
          for (const m of h.messagesAdded ?? []) if (m.message?.threadId) threadIds.add(m.message.threadId)
          for (const m of h.labelsAdded ?? []) if (m.message?.threadId) threadIds.add(m.message.threadId)
          for (const m of h.labelsRemoved ?? []) if (m.message?.threadId) threadIds.add(m.message.threadId)
        }
        pageToken = hist.nextPageToken
      } while (pageToken && threadIds.size < 300)
    } catch (err) {
      // historyId expired (404) or transient — reset cursor; the nightly
      // reconciliation / backfill heals any gap.
      console.warn(`[email-index] history sync failed for ${mailbox} (cursor reset):`, err)
    }
  }

  if (threadIds.size > 0) {
    const dir = await loadCrmDirectory()
    const ids = Array.from(threadIds)
    for (let i = 0; i < ids.length; i += 8) {
      await Promise.allSettled(ids.slice(i, i + 8).map((id) => indexThread(mailbox, id, dir)))
    }
  }

  await db
    .from("gmail_watch_state")
    .upsert(
      {
        mailbox,
        email_address: MAILBOX_ADDRESSES[mailbox],
        index_history_id: latestHistoryId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "mailbox" }
    )

  return { threads: threadIds.size }
}
