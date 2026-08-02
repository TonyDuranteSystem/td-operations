/**
 * Own-Inbox capture worker (dev_task 01800da8) — find messages that still need
 * their body+attachments captured and run the engine on them.
 *
 * Design (council):
 *  - Keyed to NEW / not-yet-complete message_ids from email_index (insert-once);
 *    runs on its OWN off-hours cron, never on the best-effort gmail-push or the
 *    10-min metadata reconcile (avoids TOAST churn + business-hours 429s).
 *  - support@ before antonio@.
 *  - The batch tally logic is dependency-injected so it is unit-testable without
 *    Gmail or a live bucket; buildCaptureDeps wires the real IO.
 */
import { gmailGet, getGmailAttachment } from "@/lib/gmail"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  captureMessageContent,
  EMAIL_CONTENT_BUCKET,
  type CaptureDeps,
  type CaptureResult,
} from "./capture"
import { assertMailbox, type Mailbox } from "./paths"

// email_message_content / email_attachment / email_index are not in the generated
// Database types yet (regenerated from production after the prod DDL). Same escape
// hatch as lib/email-index/sync.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export const MAILBOX_USER: Record<Mailbox, string> = {
  support: "support@tonydurante.us",
  antonio: "antonio.durante@tonydurante.us",
}

/**
 * INCREMENTAL new-mail detection: from the newest window of index rows, return
 * up to `limit` that aren't captured yet. Bounded on purpose — it checks
 * completeness for EXACTLY the window's ids (an `IN (...)` capped at the window),
 * never materializing the whole completed set. That avoids the PostgREST
 * ~1000-row cap that would silently truncate the completed set and stall the
 * backfill, and avoids the O(n)-per-run growth as capture nears done.
 *
 * This covers the ongoing "new mail" worker. The one-time HISTORICAL backfill of
 * the full mailbox is the dedicated runner (enumerate all ids via messages.list
 * → queue → drain), NOT this recent-window scan.
 */
export async function findUncapturedMessageIds(
  mailbox: Mailbox,
  limit: number,
): Promise<Array<{ messageId: string; threadId: string }>> {
  assertMailbox(mailbox)
  const windowSize = Math.min(1000, Math.max(limit * 4, 200))

  const { data: idx, error: idxErr } = await db
    .from("email_index")
    .select("message_id, thread_id")
    .eq("mailbox", mailbox)
    .order("internal_date", { ascending: false })
    .limit(windowSize)
  if (idxErr) throw new Error(`findUncaptured(index) failed: ${idxErr.message}`)
  const rows = (idx ?? []) as Array<{ message_id: string; thread_id: string }>
  if (rows.length === 0) return []

  // Completeness for EXACTLY this window's ids — bounded IN(), no full-set load.
  const ids = rows.map((r) => r.message_id)
  const { data: done, error: doneErr } = await db
    .from("email_message_content")
    .select("message_id")
    .eq("mailbox", mailbox)
    .eq("capture_status", "complete")
    .in("message_id", ids)
  if (doneErr) throw new Error(`findUncaptured(complete) failed: ${doneErr.message}`)
  const completed = new Set((done ?? []).map((r: { message_id: string }) => r.message_id))

  const out: Array<{ messageId: string; threadId: string }> = []
  for (const r of rows) {
    if (completed.has(r.message_id)) continue
    out.push({ messageId: r.message_id, threadId: r.thread_id })
    if (out.length >= limit) break
  }
  return out
}

/** Concrete IO for the capture engine, wired to real Gmail + Supabase. */
export function buildCaptureDeps(mailbox: Mailbox): CaptureDeps {
  assertMailbox(mailbox)
  const bucket = supabaseAdmin.storage.from(EMAIL_CONTENT_BUCKET)
  return {
    gmailUser: MAILBOX_USER[mailbox],
    now: () => new Date().toISOString(),
    gmailGet: (endpoint, params, asUser) => gmailGet(endpoint, params, asUser),
    getAttachment: (messageId, attachmentId, asUser) => getGmailAttachment(messageId, attachmentId, asUser),
    putObject: async (path, bytes, contentType) => {
      const { error } = await bucket.upload(path, bytes, { contentType, upsert: true })
      if (error) throw new Error(`storage upload ${path} failed: ${error.message}`)
    },
    getStatus: async (mb, messageId) => {
      const { data } = await db
        .from("email_message_content")
        .select("capture_status")
        .eq("mailbox", mb)
        .eq("message_id", messageId)
        .maybeSingle()
      return (data as { capture_status?: string } | null)?.capture_status ?? null
    },
    upsertAttachment: async (row) => {
      const { error } = await db.from("email_attachment").upsert(
        {
          mailbox: row.mailbox, message_id: row.message_id, thread_id: row.thread_id,
          gmail_attachment_id: row.gmail_attachment_id, filename: row.filename,
          mime_type: row.mime_type, size_bytes: row.size_bytes, storage_path: row.storage_path,
          is_inline: row.is_inline, content_id: row.content_id,
        },
        { onConflict: "mailbox,message_id,gmail_attachment_id" },
      )
      if (error) throw new Error(`upsert attachment failed: ${error.message}`)
    },
    upsertContent: async (row) => {
      const { error } = await db.from("email_message_content").upsert(
        {
          mailbox: row.mailbox, message_id: row.message_id, thread_id: row.thread_id,
          body_path: row.body_path, body_text: row.body_text, has_attachments: row.has_attachments,
          attachment_count: row.attachment_count, capture_status: row.capture_status,
          captured_at: row.captured_at, capture_error: null, updated_at: new Date().toISOString(),
        },
        { onConflict: "mailbox,message_id" },
      )
      if (error) throw new Error(`upsert content failed: ${error.message}`)
    },
    markError: async (mb, messageId, threadId, message) => {
      await db.from("email_message_content").upsert(
        {
          mailbox: mb, message_id: messageId, thread_id: threadId,
          capture_status: "error", capture_error: message.slice(0, 500),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "mailbox,message_id" },
      )
    },
  }
}

export interface BatchTally {
  found: number
  complete: number
  skipped: number
  error: number
}

export interface BatchIO {
  findUncaptured: (mailbox: Mailbox, limit: number) => Promise<Array<{ messageId: string; threadId: string }>>
  capture: (args: { mailbox: Mailbox; messageId: string; threadId: string }) => Promise<CaptureResult>
}

/** Capture one paced batch for a mailbox with BOUNDED CONCURRENCY. A pool of
 *  `concurrency` workers drains the target list — ~10-12 in-flight saturates a
 *  mailbox's Gmail quota (250 units/s ÷ 5 = 50 gets/s ÷ ~0.2s RTT ≈ 10). Default
 *  is 1 (sequential) so callers opt into speed explicitly; the runner/cron pass
 *  a higher value. Single-threaded JS makes the tally increments safe. */
export async function captureBatch(
  opts: { mailbox: Mailbox; limit: number; concurrency?: number },
  io: BatchIO,
): Promise<BatchTally> {
  assertMailbox(opts.mailbox)
  const targets = await io.findUncaptured(opts.mailbox, opts.limit)
  const tally: BatchTally = { found: targets.length, complete: 0, skipped: 0, error: 0 }
  const concurrency = Math.max(1, opts.concurrency ?? 1)
  let next = 0
  async function drain(): Promise<void> {
    while (next < targets.length) {
      const t = targets[next++]
      const res = await io.capture({ mailbox: opts.mailbox, messageId: t.messageId, threadId: t.threadId })
      if (res.status === "complete") tally.complete++
      else if (res.status === "skipped") tally.skipped++
      else tally.error++
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, drain))
  return tally
}

/** Production entry: capture a batch for a mailbox using real IO. */
export function captureBatchLive(mailbox: Mailbox, limit: number): Promise<BatchTally> {
  const deps = buildCaptureDeps(mailbox)
  return captureBatch(
    { mailbox, limit },
    {
      findUncaptured: findUncapturedMessageIds,
      capture: (args) => captureMessageContent(args, deps),
    },
  )
}
