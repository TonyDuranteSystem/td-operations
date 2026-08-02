/**
 * Own-Inbox AUTOMATIC backfill (dev_task 01800da8) — runs itself, no human step.
 *
 * The one-time history pull is ~10 min, longer than a single serverless function
 * (300s). So an off-hours cron calls runBackfillTick repeatedly: each tick walks
 * a few date-windows backward from a stored cursor, reconciles each (list Gmail →
 * store the missing), advances the cursor, and stops when its time budget is up.
 * The next tick resumes from the cursor. When the cursor reaches the mailbox's
 * oldest email, that mailbox is done. Resumable + idempotent (insert-once), so a
 * crash just re-runs. Progress (X of Y) is derivable any time for the UI.
 *
 * IO is dependency-injected so the walk/budget/done logic is unit-tested without
 * Gmail or a DB.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { reconcileWindow, type ReconcileTally } from "./reconcile"
import { MAILBOX_USER } from "./worker"
import { assertMailbox, type Mailbox } from "./paths"

// email tables aren't in the generated Database types yet (same escape as sync.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const WINDOW_DAYS = 14
/** Safety floor — no TD email predates this; stops the walk if a mailbox has no
 *  indexed rows yet. 2020-01-01. */
const FLOOR_SEC = 1577836800

export interface BackfillProgress {
  mailbox: Mailbox
  total: number
  complete: number
  remaining: number
  done: boolean
}

/** X-of-Y progress for a mailbox: how many known emails are fully stored. */
export async function backfillProgress(mailbox: Mailbox): Promise<BackfillProgress> {
  assertMailbox(mailbox)
  const [{ count: total }, { count: complete }, { data: state }] = await Promise.all([
    db.from("email_index").select("*", { count: "exact", head: true }).eq("mailbox", mailbox),
    db.from("email_message_content").select("*", { count: "exact", head: true })
      .eq("mailbox", mailbox).eq("capture_status", "complete"),
    db.from("gmail_watch_state").select("content_backfill_done").eq("mailbox", mailbox).maybeSingle(),
  ])
  const t = total ?? 0
  const c = complete ?? 0
  return {
    mailbox, total: t, complete: c, remaining: Math.max(0, t - c),
    done: state?.content_backfill_done === true,
  }
}

export interface TickIO {
  /** Cursor = beforeSec of the next (older) window to process; null = start at now. */
  getCursor: (mailbox: Mailbox) => Promise<{ cursorSec: number | null; done: boolean }>
  setCursor: (mailbox: Mailbox, cursorSec: number, done: boolean) => Promise<void>
  /** Oldest email's epoch-seconds for the mailbox (the walk floor); null if none. */
  floorSec: (mailbox: Mailbox) => Promise<number | null>
  reconcile: (mailbox: Mailbox, afterSec: number, beforeSec: number) => Promise<ReconcileTally>
}

export interface TickResult {
  mailbox: Mailbox
  windows: number
  captured: number
  errors: number
  done: boolean
}

/** Process date-windows backward until the time budget is spent or the mailbox
 *  is fully walked. Called each off-hours cron tick. */
export async function runBackfillTick(
  opts: { mailbox: Mailbox; budgetMs?: number; windowDays?: number; nowSec?: number; monotonicMs?: () => number },
  io: TickIO,
): Promise<TickResult> {
  assertMailbox(opts.mailbox)
  const budgetMs = opts.budgetMs ?? 250_000
  const windowSec = (opts.windowDays ?? WINDOW_DAYS) * 86400
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const clock = opts.monotonicMs ?? (() => Date.now())
  const start = clock()

  const { cursorSec, done } = await io.getCursor(opts.mailbox)
  const res: TickResult = { mailbox: opts.mailbox, windows: 0, captured: 0, errors: 0, done }
  if (done) return res

  const floor = Math.max(FLOOR_SEC, (await io.floorSec(opts.mailbox)) ?? nowSec)
  let cursor = cursorSec ?? nowSec + 1

  while (clock() - start < budgetMs) {
    if (cursor <= floor) {
      await io.setCursor(opts.mailbox, floor, true)
      res.done = true
      break
    }
    const afterSec = Math.max(floor, cursor - windowSec)
    const tally = await io.reconcile(opts.mailbox, afterSec, cursor)
    res.windows++
    res.captured += tally.repaired
    res.errors += tally.error
    cursor = afterSec
    await io.setCursor(opts.mailbox, cursor, cursor <= floor)
    if (cursor <= floor) {
      res.done = true
      break
    }
  }
  return res
}

// ── Concrete IO (cursor in gmail_watch_state.content_backfill_*) ─────────────

export const backfillTickIO: TickIO = {
  getCursor: async (mailbox) => {
    const { data } = await db.from("gmail_watch_state")
      .select("content_backfill_page_token, content_backfill_done")
      .eq("mailbox", mailbox).maybeSingle()
    const raw = data?.content_backfill_page_token
    const cursorSec = raw != null && raw !== "" ? parseInt(raw, 10) : null
    return { cursorSec: Number.isFinite(cursorSec as number) ? (cursorSec as number) : null, done: data?.content_backfill_done === true }
  },
  setCursor: async (mailbox, cursorSec, done) => {
    await db.from("gmail_watch_state").upsert(
      { mailbox, email_address: MAILBOX_USER[mailbox], content_backfill_page_token: String(cursorSec), content_backfill_done: done, updated_at: new Date().toISOString() },
      { onConflict: "mailbox" },
    )
  },
  floorSec: async (mailbox) => {
    const { data } = await db.from("email_index")
      .select("internal_date").eq("mailbox", mailbox)
      .order("internal_date", { ascending: true }).limit(1).maybeSingle()
    if (!data?.internal_date) return null
    return Math.floor(new Date(data.internal_date).getTime() / 1000)
  },
  reconcile: (mailbox, afterSec, beforeSec) => reconcileWindow({ mailbox, afterSec, beforeSec, concurrency: 8 }),
}
