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
 * Gmail is the SOURCE OF TRUTH for the CONTENTS of these rows. No bodies, no
 * attachments — headers, snippet, label state, CRM linkage only.
 *
 * ⚠️ THESE ROWS ARE NO LONGER SAFE TO WIPE AND REBUILD. That was true until the
 * Own-Inbox content store landed (2026-08-01): `email_message_content` and
 * `email_attachment` now reference `email_index` ON DELETE CASCADE, so a
 * `DELETE`/`TRUNCATE` here silently destroys ~27k stored bodies and ~15k stored
 * attachments and strands their bucket objects with no pointer left to purge
 * them. `20260709-0300-email-index-labels.sql` truncates this table on the old
 * assumption — do not repeat it. The bin purge in `lib/email-store/deletion.ts`
 * is the only sanctioned delete, and it removes the storage objects first.
 */

import { gmailGet, getHeader, type GmailAPIMessage } from "@/lib/gmail"
import { decodeHtmlEntities, displayNameFromHeader } from "@/lib/inbox/email-html"
import { extractEmailAddress } from "@/lib/inbox/email-unread"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { allSettledBounded } from "@/lib/inbox/bounded-settled"

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
  // NO retry here — deliberately (INCIDENT 2026-08-02). A retry-on-429 was added
  // to avoid index gaps, but this runs in the reconcile that fires every 10 min
  // over many threads: on a rate-limit each thread then re-hammered Gmail 4x with
  // backoff, holding the per-user quota the INTERACTIVE inbox shares and leaving
  // it unable to load (every row rendered "Couldn't load — retrying"). Failing
  // fast frees the quota immediately; gaps are healed by the date-window
  // reconciler (lib/email-store/reconcile.ts), which is the right tool for that.
  const thread = (await gmailGet(
    `/threads/${threadId}`,
    METADATA_PARAMS as unknown as Record<string, string | string[]>,
    MAILBOX_ADDRESSES[mailbox]
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
 * HTTP status carried by an error thrown from lib/gmail.ts, or null when the
 * error is not a Gmail API error (network failure, JSON parse, etc.). The
 * helpers there throw `Error("Gmail API <status>: …")` (also DELETE /
 * attachment / OAuth variants) — the status is only available by parsing the
 * message, so this is the single place that parsing lives.
 */
export function gmailErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  const m = /^Gmail (?:API|DELETE|attachment|OAuth error) (\d{3})\b/.exec(msg)
  return m ? Number(m[1]) : null
}

/** A failure that will NEVER succeed on retry for this thread — the thread is
 *  gone (Gmail emptied its own Trash, or a hard delete). Everything else
 *  (429, 5xx, network) is transient and worth retrying on the next sync. */
export function isPermanentGmailThreadError(err: unknown): boolean {
  const status = gmailErrorStatus(err)
  return status === 404 || status === 410
}

/** Compare-and-swap cursor advance: only writes if the cursor is still the one
 *  this run started from. A lost CAS means a concurrent run advanced first —
 *  its advance was also clean, so losing is safe and silent. */
async function casAdvanceCursor(
  mailbox: "support" | "antonio",
  expected: string,
  target: string
): Promise<void> {
  await db
    .from("gmail_watch_state")
    .update({ index_history_id: target, updated_at: new Date().toISOString() })
    .eq("mailbox", mailbox)
    .eq("index_history_id", expected)
}

export interface IncrementalSyncResult {
  threads: number
  /** true = a transient failure stopped processing; the cursor was deliberately
   *  NOT advanced past the failed span, so the next push/cron retries it. */
  cursorHeld: boolean
  /** true = Gmail reported our cursor expired (~7-day history window); the
   *  cursor was reset to `latestHistoryId` and the skipped span needs the
   *  label reconciler to heal. */
  cursorExpired: boolean
}

/**
 * Index everything that changed since the last indexed historyId.
 * Called (best-effort) from the gmail-push webhook and the 10-min cron.
 *
 * CURSOR DISCIPLINE (council rework, 2026-08-07 — the old version advanced the
 * cursor unconditionally, permanently skipping any span whose read failed, and
 * nothing else ever repairs `label_ids`; that is how an archived email becomes
 * a phantom-INBOX row that pops back forever):
 *  - pages are processed one at a time; the cursor target only advances past a
 *    page whose threads ALL indexed (or failed permanently — a 404'd thread is
 *    gone and will never index);
 *  - a TRANSIENT failure (429/5xx/network) stops the run and holds the cursor
 *    at the last clean page, so the next push retries the failed span — never
 *    a permanent skip, never a poison-thread wedge;
 *  - an EXPIRED cursor (404 from history.list) resets to `latestHistoryId` —
 *    refusing to advance would wedge sync forever, since an expired id never
 *    becomes valid again. The skipped span is the label reconciler's job.
 *  - the write is compare-and-swap on the starting cursor, so two concurrent
 *    runs cannot leapfrog each other over an unprocessed span.
 */
export async function syncIncremental(
  mailbox: "support" | "antonio",
  latestHistoryId: string
): Promise<IncrementalSyncResult> {
  const { data: state } = await db
    .from("gmail_watch_state")
    .select("index_history_id")
    .eq("mailbox", mailbox)
    .maybeSingle()

  const since: string | undefined = state?.index_history_id ?? undefined

  // First run (or an unparseable cursor from a bygone format): nothing to
  // replay — stamp the current position so the NEXT sync has a valid start.
  let sinceBig: bigint | null = null
  try {
    if (since) sinceBig = BigInt(since)
  } catch {
    sinceBig = null
  }
  if (!since || sinceBig === null) {
    await db.from("gmail_watch_state").upsert(
      {
        mailbox,
        email_address: MAILBOX_ADDRESSES[mailbox],
        index_history_id: latestHistoryId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "mailbox" }
    )
    return { threads: 0, cursorHeld: false, cursorExpired: false }
  }

  let dir: CrmDirectory | null = null
  let processed = 0
  /** Highest history-record id of a FULLY processed page. */
  let cleanCursor: bigint | null = null
  let held = false
  let expired = false
  let drained = false

  try {
    let pageToken: string | undefined
    do {
      const params: Record<string, string> = { startHistoryId: since, maxResults: "100" }
      if (pageToken) params.pageToken = pageToken
      const hist = (await gmailGet("/history", params, MAILBOX_ADDRESSES[mailbox])) as {
        history?: Array<{
          id?: string
          messages?: Array<{ threadId?: string }>
          messagesAdded?: Array<{ message?: { threadId?: string } }>
          labelsAdded?: Array<{ message?: { threadId?: string } }>
          labelsRemoved?: Array<{ message?: { threadId?: string } }>
        }>
        nextPageToken?: string
      }

      const pageThreads = new Set<string>()
      let pageMaxId = BigInt(0)
      for (const h of hist.history ?? []) {
        if (h.id) {
          try {
            const v = BigInt(h.id)
            if (v > pageMaxId) pageMaxId = v
          } catch {
            // Non-numeric record id — ignore for cursor purposes.
          }
        }
        for (const m of h.messages ?? []) if (m.threadId) pageThreads.add(m.threadId)
        for (const m of h.messagesAdded ?? []) if (m.message?.threadId) pageThreads.add(m.message.threadId)
        for (const m of h.labelsAdded ?? []) if (m.message?.threadId) pageThreads.add(m.message.threadId)
        for (const m of h.labelsRemoved ?? []) if (m.message?.threadId) pageThreads.add(m.message.threadId)
      }

      if (pageThreads.size > 0) {
        dir ??= await loadCrmDirectory()
        const ids = Array.from(pageThreads)
        const results = await allSettledBounded(ids, 8, (id) => indexThread(mailbox, id, dir!))
        processed += ids.length
        const transientFailure = results.some(
          (r) => r.status === "rejected" && !isPermanentGmailThreadError(r.reason)
        )
        if (transientFailure) {
          held = true
          break
        }
      }

      if (pageMaxId > BigInt(0)) cleanCursor = pageMaxId
      pageToken = hist.nextPageToken
      drained = !pageToken
    } while (pageToken && processed < 300)
  } catch (err) {
    if (gmailErrorStatus(err) === 404) {
      // Cursor expired: reset (below) or sync wedges forever on this id.
      expired = true
      console.warn(`[email-index] history cursor expired for ${mailbox} — resetting; reconciler must heal the gap`)
    } else {
      held = true
      console.warn(`[email-index] history sync failed for ${mailbox} (cursor held):`, err)
    }
  }

  if (expired) {
    await casAdvanceCursor(mailbox, since, latestHistoryId)
  } else if (!held && drained) {
    // Fully caught up with no failures — current through the push's id.
    let latestBig = BigInt(0)
    try {
      latestBig = BigInt(latestHistoryId)
    } catch {
      latestBig = BigInt(0)
    }
    const target = cleanCursor !== null && cleanCursor > latestBig ? cleanCursor.toString() : latestHistoryId
    if (latestBig > sinceBig || (cleanCursor !== null && cleanCursor > sinceBig)) {
      await casAdvanceCursor(mailbox, since, target)
    }
  } else if (cleanCursor !== null && cleanCursor > sinceBig) {
    // Partial progress (transient failure or the 300-thread cap): advance only
    // past the pages that fully processed; the remainder replays next sync.
    await casAdvanceCursor(mailbox, since, cleanCursor.toString())
  }
  // held with zero clean pages → no write at all: full replay next sync.

  return { threads: processed, cursorHeld: held, cursorExpired: expired }
}

// ─── Post-action reindex (write path freshness) ─────────

/**
 * Re-index the acted-on threads THROUGH THE ONE WRITER (`indexThread`) right
 * after a successful Gmail label mutation, so index-served views (browse,
 * search, Archived) reflect the action immediately instead of waiting for the
 * push echo. Architect's rule, 2026-08-07: never patch `label_ids` directly —
 * a second composer of index rows is how per-message truth gets clobbered.
 *
 * Best-effort by design: the Gmail action already succeeded and is what the
 * user was told; a failure here is healed by that same action's push event.
 */
export async function reindexThreadsAfterAction(
  mailbox: "support" | "antonio",
  threadIds: string[]
): Promise<void> {
  const ids = Array.from(new Set(threadIds.filter(Boolean)))
  if (ids.length === 0) return
  try {
    const dir = await loadCrmDirectory()
    await allSettledBounded(ids, 8, (id) => indexThread(mailbox, id, dir))
  } catch (err) {
    console.warn(`[email-index] post-action reindex failed (push will heal):`, err)
  }
}
