/**
 * Own-Inbox DELETION MIRROR + 180-DAY BIN (dev_task 01800da8).
 *
 * Antonio: "If we delete an email in our inbox, Gmail must be cleaned up as
 * well, and we always have to have the option to go in the bin and recover an
 * email that maybe mistakenly was deleted." Retention: 180 days.
 *
 * Deleting in the CRM already trashes the thread in Gmail and restore already
 * works. What this adds is our own copy's side of it:
 *
 *  - MARK: `deleted_at` is stamped when a message is observed in Gmail's TRASH.
 *    The CRM delete stamps it immediately for responsiveness, but the SOURCE OF
 *    TRUTH is `reconcileBinState()` — a sweep over `email_index.label_ids`, run
 *    by the index-sync cron. That sweep is what makes the bin honest: an email
 *    Antonio deletes from the Gmail app on his phone never touches our API, and
 *    without the sweep it would be kept forever with no clock (246 such copies
 *    existed on production when this shipped).
 *  - UNMARK: the same sweep clears the stamp when TRASH goes away, so an email
 *    restored inside Gmail stops counting down. Without it, a restore done in
 *    Gmail rather than the CRM would silently destroy the copy of a LIVE email
 *    at day 180 (found by the bug-hunter + data-migration reviewers, 2026-08-04).
 *  - PURGE: past the window, the storage objects go first and the `email_index`
 *    row last (it cascades the content + attachment rows). Storage first because
 *    the rows are the only pointers to the bytes; the index row because leaving
 *    it makes the capture worker re-download the message forever, and because a
 *    purged email must not stay listed with its subject and snippet intact.
 *  - ERASE NOW: `purgeMessagesNow()` backs "Delete forever" — the same purge,
 *    inline, for messages the user does not want us holding at all.
 *
 * IO is dependency-injected so the retention/ordering rules are unit-tested
 * without a database or bucket.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { EMAIL_CONTENT_BUCKET } from "./capture"
import { assertMailbox, type Mailbox } from "./paths"

// email tables aren't in the generated Database types yet (same escape as sync.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** Antonio's retention decision: 180 days in the bin before we let go. */
export const BIN_RETENTION_DAYS = 180

/**
 * PURE: is this deleted copy past its bin window?
 * A null stamp means the message is live — never purge those.
 */
export function isPastRetention(
  deletedAtIso: string | null | undefined,
  nowMs: number,
  retentionDays: number = BIN_RETENTION_DAYS,
): boolean {
  if (!deletedAtIso) return false
  const t = new Date(deletedAtIso).getTime()
  if (!Number.isFinite(t)) return false // unparseable stamp → keep, don't guess
  return nowMs - t >= retentionDays * 86_400_000
}

/**
 * PURE: split an index snapshot into the messages whose bin state is WRONG.
 *
 * `toBin` = in Gmail's Trash but not stamped. `toRestore` = stamped but no
 * longer in Trash. Everything already consistent is left alone, so the sweep
 * writes nothing on a quiet run.
 */
export function binStateDrift(
  rows: Array<{ messageId: string; labelIds: string[] | null; deletedAt: string | null }>,
): { toBin: string[]; toRestore: string[] } {
  const toBin: string[] = []
  const toRestore: string[] = []
  for (const r of rows) {
    const trashed = (r.labelIds ?? []).includes("TRASH")
    if (trashed && !r.deletedAt) toBin.push(r.messageId)
    else if (!trashed && r.deletedAt) toRestore.push(r.messageId)
  }
  return { toBin, toRestore }
}

/**
 * PURE: every storage object belonging to one captured message.
 *
 * `recorded` are the paths the DB knows about; `listed` are the objects actually
 * found under the message's storage prefix. BOTH are purged: a capture that
 * uploaded the body and then failed leaves bytes with no row pointing at them
 * (`markError` writes `body_path` NULL), and purging only the recorded paths
 * would strand those PII bytes in the bucket permanently (bug-hunter, 2026-08-04).
 */
export function objectsToPurge(input: {
  bodyPath?: string | null
  attachmentPaths?: Array<string | null | undefined>
  listedPaths?: Array<string | null | undefined>
}): string[] {
  const all = [input.bodyPath, ...(input.attachmentPaths ?? []), ...(input.listedPaths ?? [])]
  return Array.from(new Set(all.filter((p): p is string => typeof p === "string" && p.length > 0)))
}

export interface ExpiredItem {
  mailbox: Mailbox
  messageId: string
  deletedAt: string | null
  bodyPath: string | null
  attachmentPaths: string[]
}

export interface PurgeIO {
  /** Deleted copies past their window, oldest first. */
  listExpired: (nowMs: number) => Promise<ExpiredItem[]>
  /** Re-read the bin stamp immediately before destroying anything (TOCTOU guard). */
  currentDeletedAt: (mailbox: Mailbox, messageId: string) => Promise<string | null>
  /** Every object actually present under this message's storage prefix. */
  listObjects: (mailbox: Mailbox, messageId: string) => Promise<string[]>
  /** The storage paths the DB records for one message. */
  recordedPaths: (mailbox: Mailbox, messageId: string) => Promise<{ bodyPath: string | null; attachmentPaths: string[] }>
  /** Must throw unless EVERY path was removed. */
  removeObjects: (paths: string[]) => Promise<void>
  /** Removes the index row; content + attachment rows cascade from it. */
  removeRows: (mailbox: Mailbox, messageId: string) => Promise<void>
}

export interface PurgeTally {
  examined: number
  purged: number
  objectsRemoved: number
  restored: number
  errors: number
}

const emptyTally = (examined = 0): PurgeTally => ({
  examined, purged: 0, objectsRemoved: 0, restored: 0, errors: 0,
})

/**
 * Destroy one message's copy for good. Storage first, then the index row —
 * never the reverse: the rows hold the only pointers to the bytes.
 */
async function purgeOne(item: ExpiredItem, io: PurgeIO, tally: PurgeTally): Promise<void> {
  const paths = objectsToPurge({
    bodyPath: item.bodyPath,
    attachmentPaths: item.attachmentPaths,
    listedPaths: await io.listObjects(item.mailbox, item.messageId),
  })
  if (paths.length > 0) {
    await io.removeObjects(paths)
    tally.objectsRemoved += paths.length
  }
  await io.removeRows(item.mailbox, item.messageId)
  tally.purged++
}

/**
 * Purge every copy past its retention window.
 *
 * Each item's stamp is re-read immediately before it is destroyed: the batch is
 * read once, but a staff member can restore a thread from the Trash while the
 * sweep is mid-run, and acting on the stale snapshot would permanently destroy
 * the only copy of an email that had just been recovered.
 */
export async function purgeExpired(nowMs: number, io: PurgeIO): Promise<PurgeTally> {
  const expired = await io.listExpired(nowMs)
  const tally = emptyTally(expired.length)

  for (const item of expired) {
    try {
      const current = await io.currentDeletedAt(item.mailbox, item.messageId)
      if (!isPastRetention(current, nowMs)) {
        // Restored (or un-stamped) since the batch was read — leave it alone.
        tally.restored++
        continue
      }
      await purgeOne(item, io, tally)
    } catch {
      // Leave the rows in place — retried on the next sweep. Silently dropping
      // them is how you orphan storage bytes forever.
      tally.errors++
    }
  }
  return tally
}

/**
 * "Delete forever": erase these messages' copies right now, no waiting.
 *
 * Deliberately NOT "stamp the epoch and let the nightly sweep do it" — the user
 * is told the email is gone, so it has to be gone, not gone-by-tomorrow.
 */
export async function purgeMessagesNow(
  mailbox: Mailbox,
  messageIds: string[],
  io: PurgeIO = purgeIO,
): Promise<PurgeTally> {
  assertMailbox(mailbox)
  const tally = emptyTally(messageIds.length)
  for (const messageId of messageIds) {
    try {
      const recorded = await io.recordedPaths(mailbox, messageId)
      await purgeOne({ mailbox, messageId, deletedAt: null, ...recorded }, io, tally)
    } catch {
      tally.errors++
    }
  }
  return tally
}

// ── Marking ──────────────────────────────────────────────────────────────────

/**
 * What to stamp. Inbox actions are thread-scoped (the user deletes a
 * conversation, not a message), so `threadIds` is the normal selector for the
 * CRM delete. `messageIds` is used where the caller has already narrowed to the
 * exact messages — notably "delete forever", which must never touch a live
 * message sharing a partly-trashed thread.
 */
export type BinSelector = { threadIds: string[] } | { messageIds: string[] }

function selectorIsEmpty(sel: BinSelector): boolean {
  return "threadIds" in sel ? sel.threadIds.length === 0 : sel.messageIds.length === 0
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applySelector(q: any, sel: BinSelector) {
  return "threadIds" in sel ? q.in("thread_id", sel.threadIds) : q.in("message_id", sel.messageIds)
}

/** Stamp the bin clock for copies whose email was deleted (no-op if already stamped). */
export async function markDeleted(
  mailbox: Mailbox,
  sel: BinSelector,
  whenIso: string = new Date().toISOString(),
): Promise<number> {
  assertMailbox(mailbox)
  if (selectorIsEmpty(sel)) return 0
  const base = db
    .from("email_message_content")
    .update({ deleted_at: whenIso, updated_at: new Date().toISOString() })
    .eq("mailbox", mailbox)
  const { data, error } = await applySelector(base, sel)
    .is("deleted_at", null) // don't restart the clock on an already-binned copy
    .select("message_id")
  if (error) throw new Error(`markDeleted failed: ${error.message}`)
  return (data ?? []).length
}

/** Clear the bin clock — the email came back (restored from Trash). */
export async function markRestored(mailbox: Mailbox, sel: BinSelector): Promise<number> {
  assertMailbox(mailbox)
  if (selectorIsEmpty(sel)) return 0
  const base = db
    .from("email_message_content")
    .update({ deleted_at: null, updated_at: new Date().toISOString() })
    .eq("mailbox", mailbox)
  const { data, error } = await applySelector(base, sel)
    .not("deleted_at", "is", null)
    .select("message_id")
  if (error) throw new Error(`markRestored failed: ${error.message}`)
  return (data ?? []).length
}

/**
 * THE SOURCE OF TRUTH for bin state: reconcile every stored copy against the
 * labels Gmail last told us about, in both directions.
 *
 * Runs from the index-sync cron, right after the labels are refreshed. Bounded
 * per pass; the drift set is normally empty, so a quiet run writes nothing.
 */
export async function reconcileBinState(limit = 500): Promise<{ binned: number; restored: number }> {
  let binned = 0
  let restored = 0
  for (const mailbox of ["support", "antonio"] as Mailbox[]) {
    const { data, error } = await db
      .from("email_message_content")
      .select("message_id, deleted_at, email_index!inner(label_ids)")
      .eq("mailbox", mailbox)
      .limit(limit)
    if (error) throw new Error(`reconcileBinState failed: ${error.message}`)

    type Row = { message_id: string; deleted_at: string | null; email_index: { label_ids: string[] | null } | Array<{ label_ids: string[] | null }> }
    const rows = ((data ?? []) as Row[]).map((r) => {
      const idx = Array.isArray(r.email_index) ? r.email_index[0] : r.email_index
      return { messageId: r.message_id, labelIds: idx?.label_ids ?? null, deletedAt: r.deleted_at }
    })

    const { toBin, toRestore } = binStateDrift(rows)
    if (toBin.length) binned += await markDeleted(mailbox, { messageIds: toBin })
    if (toRestore.length) restored += await markRestored(mailbox, { messageIds: toRestore })
  }
  return { binned, restored }
}

// ── Concrete IO ──────────────────────────────────────────────────────────────

const bucket = () => supabaseAdmin.storage.from(EMAIL_CONTENT_BUCKET)

export const purgeIO: PurgeIO = {
  listExpired: async (nowMs) => {
    const cutoff = new Date(nowMs - BIN_RETENTION_DAYS * 86_400_000).toISOString()
    const { data, error } = await db
      .from("email_message_content")
      .select("mailbox, message_id, deleted_at, body_path")
      .not("deleted_at", "is", null)
      .lte("deleted_at", cutoff)
      // Oldest first, deterministically: without an order the same 200 rows can
      // come back every night, so a permanently-failing row head-blocks the bin
      // and nothing behind it ever drains.
      .order("deleted_at", { ascending: true })
      .limit(200)
    if (error) throw new Error(`listExpired failed: ${error.message}`)

    const rows = (data ?? []) as Array<{ mailbox: Mailbox; message_id: string; deleted_at: string; body_path: string | null }>
    const out: ExpiredItem[] = []
    for (const r of rows) {
      const { data: atts } = await db
        .from("email_attachment")
        .select("storage_path")
        .eq("mailbox", r.mailbox)
        .eq("message_id", r.message_id)
      out.push({
        mailbox: r.mailbox,
        messageId: r.message_id,
        deletedAt: r.deleted_at,
        bodyPath: r.body_path,
        attachmentPaths: ((atts ?? []) as Array<{ storage_path: string }>).map((a) => a.storage_path),
      })
    }
    return out
  },

  recordedPaths: async (mailbox, messageId) => {
    const { data } = await db
      .from("email_message_content")
      .select("body_path")
      .eq("mailbox", mailbox)
      .eq("message_id", messageId)
      .maybeSingle()
    const { data: atts } = await db
      .from("email_attachment")
      .select("storage_path")
      .eq("mailbox", mailbox)
      .eq("message_id", messageId)
    return {
      bodyPath: (data as { body_path?: string | null } | null)?.body_path ?? null,
      attachmentPaths: ((atts ?? []) as Array<{ storage_path: string }>).map((a) => a.storage_path),
    }
  },

  currentDeletedAt: async (mailbox, messageId) => {
    const { data } = await db
      .from("email_message_content")
      .select("deleted_at")
      .eq("mailbox", mailbox)
      .eq("message_id", messageId)
      .maybeSingle()
    return (data as { deleted_at?: string | null } | null)?.deleted_at ?? null
  },

  listObjects: async (mailbox, messageId) => {
    // Every object for a message lives under `<mailbox>/<messageId>/` —
    // `body.html` and `att/<hash>` (see paths.ts). Listing catches bytes the DB
    // has no pointer to, which is exactly what an interrupted capture leaves.
    const prefix = `${mailbox}/${messageId}`
    const found: string[] = []
    for (const sub of ["", "/att"]) {
      const { data } = await bucket().list(`${prefix}${sub}`, { limit: 1000 })
      for (const o of (data ?? []) as Array<{ name: string; id?: string | null }>) {
        // Folder placeholders come back with a null id — skip them.
        if (o.id === null) continue
        found.push(`${prefix}${sub}/${o.name}`)
      }
    }
    return found
  },

  removeObjects: async (paths) => {
    // Chunked: a single remove() call takes a bounded list.
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100)
      const { data, error } = await bucket().remove(chunk)
      if (error) throw new Error(`storage remove failed: ${error.message}`)
      // remove() reports WHICH objects it deleted and does not error on a path
      // it could not touch. Treating a partial removal as success would drop the
      // row that holds the only pointer to the surviving bytes.
      const removed = (data ?? []).length
      if (removed !== chunk.length) {
        throw new Error(`storage remove incomplete: ${removed}/${chunk.length}`)
      }
    }
  },

  removeRows: async (mailbox, messageId) => {
    // The link rows first — they are the join to accounts/contacts/leads, and an
    // orphan would leave a purged email listed on a client record.
    await db.from("email_links").delete().eq("mailbox", mailbox).eq("message_id", messageId)

    // ONE delete, on `email_index` — the metadata row. Both `email_message_content`
    // and `email_attachment` reference it ON DELETE CASCADE (verified on production
    // 2026-08-04), so all three go together atomically instead of in a sequence
    // that can half-fail.
    //
    // Deleting the INDEX row is the point, not a side effect. It holds the
    // sender, subject, recipients and body snippet plus a full-text index over
    // them — leaving it means the email is still listed and still searchable
    // after we told the user it was erased. It would also make `findUncaptured`
    // (worker.ts) treat the message as "not captured yet" and re-download it from
    // Gmail on every pass, forever.
    const { error } = await db
      .from("email_index")
      .delete()
      .eq("mailbox", mailbox)
      .eq("message_id", messageId)
    if (error) throw new Error(`removeRows failed: ${error.message}`)
  },
}
