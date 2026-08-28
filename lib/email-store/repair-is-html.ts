/**
 * Own-Inbox `is_html` REPAIR pass (dev_task 1c453653-e93a-4875-bcd6-6033070d062b)
 * — one-time correction for messages captured BEFORE the is_html column existed.
 *
 * lib/email-store/read.ts used to guess HTML-vs-plain-text by content-sniffing
 * the saved body text, which misfires on ordinary plain text containing a
 * bracketed link or a quoted address (2026-08-27 fix). Every message captured
 * from that fix onward gets the real, MIME-derived flag for free (captured at
 * write time by lib/email-store/capture.ts). This module closes the gap for
 * everything captured BEFORE that: it re-asks Gmail for just the MIME
 * structure of each already-complete row and writes the real answer.
 *
 * Deliberately CHEAPER than the original capture, not a re-capture: ONE Gmail
 * get per message (format:full, same call captureMessageContent already makes)
 * with NO attachment downloads and NO storage upload — body_path/body_text are
 * already stored and untouched; only the is_html column is written. Antonio
 * asked for every historical email to render correctly (2026-08-27), so this
 * runs to completion rather than being left as a permanent content-sniff
 * fallback — but it still goes through the same bounded-concurrency,
 * retry-on-429/5xx pattern as every other Gmail-quota-sensitive job in this
 * module (lib/email-store/reconcile.ts, lib/email-store/runner.ts) so a full
 * historical sweep can't repeat the 2026-08-02 quota incident.
 *
 * IO is dependency-injected so the batch/backoff logic is unit-tested without
 * Gmail or a live DB.
 */
import { gmailGet, extractBodyWithType, type GmailAPIMessage } from "@/lib/gmail"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { withGmailRetry } from "./capture"
import { drainPool } from "./runner"
import { MAILBOX_USER } from "./worker"
import { assertMailbox, type Mailbox } from "./paths"

// email_message_content isn't in the generated Database types yet (same escape
// hatch as lib/email-index/sync.ts / lib/email-store/read.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export interface PendingRow {
  message_id: string
}

export interface RepairIO {
  /** Up to `limit` complete rows still missing is_html, for one mailbox. */
  fetchPending: (mailbox: Mailbox, limit: number) => Promise<PendingRow[]>
  /** One Gmail get (format:full) — the real, MIME-derived answer. */
  resolveIsHtml: (mailbox: Mailbox, messageId: string) => Promise<boolean>
  /** Persist the answer. Never touches body_path/body_text/capture_status. */
  updateIsHtml: (mailbox: Mailbox, messageId: string, isHtml: boolean) => Promise<void>
  /** Record a message we couldn't resolve (e.g. deleted at Gmail since capture)
   *  so a batch's un-resolvable rows don't get re-fetched forever. */
  markUnresolvable?: (mailbox: Mailbox, messageId: string, reason: string) => Promise<void>
}

export interface RepairBatchResult {
  mailbox: Mailbox
  fetched: number
  updated: number
  errors: number
}

/** One bounded batch: pull up to `limit` NULL rows, resolve + persist each with
 *  bounded concurrency. A single message's failure never aborts the batch —
 *  it's counted and left for the next run (insert-once-style idempotency). */
export async function repairIsHtmlBatch(
  mailbox: Mailbox,
  io: RepairIO,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<RepairBatchResult> {
  assertMailbox(mailbox)
  const limit = opts.limit ?? 200
  const concurrency = opts.concurrency ?? 6

  const pending = await io.fetchPending(mailbox, limit)
  const result: RepairBatchResult = { mailbox, fetched: pending.length, updated: 0, errors: 0 }

  await drainPool(pending, concurrency, async (row) => {
    try {
      const isHtml = await io.resolveIsHtml(mailbox, row.message_id)
      await io.updateIsHtml(mailbox, row.message_id, isHtml)
      result.updated++
    } catch (err) {
      result.errors++
      const message = err instanceof Error ? err.message : String(err)
      // A message Gmail no longer has (deleted since capture) will 404 forever —
      // mark it so it stops consuming batch slots, instead of retrying forever.
      if (/Gmail API 404/.test(message) && io.markUnresolvable) {
        await io.markUnresolvable(mailbox, row.message_id, message).catch(() => {})
      }
    }
  })
  return result
}

/** Repeat repairIsHtmlBatch until a mailbox has no NULL rows left. Returns the
 *  running totals. `sleepMs` between batches keeps this well under quota even
 *  across tens of thousands of rows (default 1s — the batch's own concurrency
 *  cap already throttles within a batch). */
export async function repairAllIsHtml(
  mailbox: Mailbox,
  io: RepairIO,
  opts: { limit?: number; concurrency?: number; sleepMs?: number; onBatch?: (r: RepairBatchResult) => void } = {},
): Promise<{ mailbox: Mailbox; batches: number; updated: number; errors: number }> {
  assertMailbox(mailbox)
  const sleepMs = opts.sleepMs ?? 1000
  const totals = { mailbox, batches: 0, updated: 0, errors: 0 }
  for (;;) {
    const res = await repairIsHtmlBatch(mailbox, io, opts)
    totals.batches++
    totals.updated += res.updated
    totals.errors += res.errors
    opts.onBatch?.(res)
    if (res.fetched === 0) break
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs))
  }
  return totals
}

// ── Concrete IO (real Gmail + Supabase) ──────────────────────────────────────

export function buildRepairIO(): RepairIO {
  return {
    fetchPending: async (mailbox, limit) => {
      const { data, error } = await db
        .from("email_message_content")
        .select("message_id")
        .eq("mailbox", mailbox)
        .eq("capture_status", "complete")
        .is("is_html", null)
        .order("captured_at", { ascending: true })
        .limit(limit)
      if (error) throw new Error(`fetchPending failed: ${error.message}`)
      return (data ?? []) as PendingRow[]
    },
    resolveIsHtml: async (mailbox, messageId) => {
      const full = (await withGmailRetry(() =>
        gmailGet(`/messages/${messageId}`, { format: "full" }, MAILBOX_USER[mailbox]),
      )) as GmailAPIMessage
      return extractBodyWithType(full.payload).isHtml
    },
    updateIsHtml: async (mailbox, messageId, isHtml) => {
      const { error } = await db
        .from("email_message_content")
        .update({ is_html: isHtml, updated_at: new Date().toISOString() })
        .eq("mailbox", mailbox)
        .eq("message_id", messageId)
      if (error) throw new Error(`updateIsHtml failed: ${error.message}`)
    },
    markUnresolvable: async (mailbox, messageId, reason) => {
      // Gmail no longer has this message (deleted since capture) — stamp
      // is_html=false (renders as plain text, the safer of the two guesses for
      // dead-end content nobody will act on) so it stops recurring in fetchPending.
      await db
        .from("email_message_content")
        .update({ is_html: false, capture_error: reason.slice(0, 500), updated_at: new Date().toISOString() })
        .eq("mailbox", mailbox)
        .eq("message_id", messageId)
    },
  }
}
