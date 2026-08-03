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
 *  - MARK: when a message is observed in Gmail's TRASH (or gone entirely), we
 *    stamp `deleted_at`. That starts the bin clock — the copy is kept, not
 *    dropped, so it stays readable. Gmail purges its own Trash at ~30 days, so
 *    past that our copy is the ONLY copy; that is the point.
 *  - UNMARK: if it comes back (restored in Gmail), the stamp is cleared and the
 *    copy is fully live again.
 *  - PURGE: past the retention window the row AND its stored objects go, for
 *    real. Storage is deleted BEFORE the row so a crash can never orphan bytes
 *    with no pointer to them (the row is the only record of what to delete).
 *  - DELETE FOREVER: stamps the epoch so the very next sweep purges it, no wait.
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

/** Epoch — the "purge on the next sweep" marker used by delete-forever. */
export const PURGE_NOW_ISO = "1970-01-01T00:00:00.000Z"

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
 * PURE: every storage object belonging to one captured message — its body and
 * each attachment. The purge deletes exactly this set.
 */
export function objectsToPurge(input: {
  bodyPath: string | null | undefined
  attachmentPaths: Array<string | null | undefined>
}): string[] {
  const all = [input.bodyPath, ...input.attachmentPaths]
  return Array.from(new Set(all.filter((p): p is string => typeof p === "string" && p.length > 0)))
}

export interface PurgeIO {
  /** Deleted copies past their window: message ids + their object paths. */
  listExpired: (nowMs: number) => Promise<Array<{
    mailbox: Mailbox
    messageId: string
    bodyPath: string | null
    attachmentPaths: string[]
  }>>
  removeObjects: (paths: string[]) => Promise<void>
  removeRows: (mailbox: Mailbox, messageId: string) => Promise<void>
}

export interface PurgeTally {
  examined: number
  purged: number
  objectsRemoved: number
  errors: number
}

/**
 * Purge every copy past its retention window. Storage first, then the row —
 * never the reverse: the row holds the only pointers to the bytes, so dropping
 * it first would strand them permanently.
 */
export async function purgeExpired(nowMs: number, io: PurgeIO): Promise<PurgeTally> {
  const expired = await io.listExpired(nowMs)
  const tally: PurgeTally = { examined: expired.length, purged: 0, objectsRemoved: 0, errors: 0 }

  for (const item of expired) {
    const paths = objectsToPurge({ bodyPath: item.bodyPath, attachmentPaths: item.attachmentPaths })
    try {
      if (paths.length > 0) {
        await io.removeObjects(paths)
        tally.objectsRemoved += paths.length
      }
      await io.removeRows(item.mailbox, item.messageId)
      tally.purged++
    } catch {
      // Leave the row in place — it will be retried on the next sweep. Silently
      // dropping it is how you orphan storage bytes forever.
      tally.errors++
    }
  }
  return tally
}

// ── Concrete IO ──────────────────────────────────────────────────────────────

/**
 * What to stamp. Inbox actions are thread-scoped (the user deletes a
 * conversation, not a message), so `threadIds` is the normal selector — and it
 * is also the SAFER one: it covers every captured message of the thread,
 * including any Gmail no longer lists back to us.
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
 * Delete forever: stamp the epoch so the next sweep purges immediately.
 * Unlike markDeleted this deliberately has NO "already stamped" guard — a
 * message sitting in the bin must still be purgeable on demand.
 */
export async function markPurgeNow(mailbox: Mailbox, sel: BinSelector): Promise<number> {
  assertMailbox(mailbox)
  if (selectorIsEmpty(sel)) return 0
  const base = db
    .from("email_message_content")
    .update({ deleted_at: PURGE_NOW_ISO, updated_at: new Date().toISOString() })
    .eq("mailbox", mailbox)
  const { data, error } = await applySelector(base, sel).select("message_id")
  if (error) throw new Error(`markPurgeNow failed: ${error.message}`)
  return (data ?? []).length
}

export const purgeIO: PurgeIO = {
  listExpired: async (nowMs) => {
    const cutoff = new Date(nowMs - BIN_RETENTION_DAYS * 86_400_000).toISOString()
    const { data, error } = await db
      .from("email_message_content")
      .select("mailbox, message_id, body_path")
      .not("deleted_at", "is", null)
      .lte("deleted_at", cutoff)
      .limit(200) // bounded per sweep — the next tick takes the rest
    if (error) throw new Error(`listExpired failed: ${error.message}`)

    const rows = (data ?? []) as Array<{ mailbox: Mailbox; message_id: string; body_path: string | null }>
    const out: Array<{ mailbox: Mailbox; messageId: string; bodyPath: string | null; attachmentPaths: string[] }> = []
    for (const r of rows) {
      const { data: atts } = await db
        .from("email_attachment")
        .select("storage_path")
        .eq("mailbox", r.mailbox)
        .eq("message_id", r.message_id)
      out.push({
        mailbox: r.mailbox,
        messageId: r.message_id,
        bodyPath: r.body_path,
        attachmentPaths: ((atts ?? []) as Array<{ storage_path: string }>).map((a) => a.storage_path),
      })
    }
    return out
  },
  removeObjects: async (paths) => {
    const { error } = await supabaseAdmin.storage.from(EMAIL_CONTENT_BUCKET).remove(paths)
    if (error) throw new Error(`storage remove failed: ${error.message}`)
  },
  removeRows: async (mailbox, messageId) => {
    // Attachments first: they carry the storage pointers, and the content row is
    // what the sweep re-finds on a retry.
    await db.from("email_attachment").delete().eq("mailbox", mailbox).eq("message_id", messageId)
    const { error } = await db
      .from("email_message_content")
      .delete()
      .eq("mailbox", mailbox)
      .eq("message_id", messageId)
    if (error) throw new Error(`removeRows failed: ${error.message}`)
  },
}
