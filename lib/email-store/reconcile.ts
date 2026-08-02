/**
 * Own-Inbox completeness reconciler (dev_task 01800da8) — the "did we get
 * everything?" safety net the council required.
 *
 * It does NOT trust Gmail's 7-day history cursor (a lapsed watch or a swallowed
 * error leaves a permanent, undetectable gap). Instead it asks Gmail directly:
 * "list every message id in this date window" (messages.list with after:/before:),
 * diffs that against what we have stored as 'complete', and captures the missing
 * ones. Run periodically over recent windows (cron) or over any window as an
 * audit/heal. Independent of email_index and of the history pipeline, so it
 * catches gaps from ANY source (backfill drop, missed push, expired history).
 *
 * IO is dependency-injected so the diff/heal logic is unit-tested without Gmail.
 */
import { gmailGet } from "@/lib/gmail"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { captureMessageContent, type CaptureResult } from "./capture"
import { buildCaptureDeps, MAILBOX_USER } from "./worker"
import { drainPool, type MsgRef } from "./runner"
import { assertMailbox, type Mailbox } from "./paths"

// email tables aren't in the generated Database types yet (same escape as sync.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** List every message id Gmail holds in [afterSec, beforeSec) for a mailbox. */
export async function listMessageIdsInWindow(
  gmailUser: string,
  afterSec: number,
  beforeSec: number,
  get: (endpoint: string, params?: Record<string, string>, asUser?: string) => Promise<any> = gmailGet,
): Promise<MsgRef[]> {
  const out: MsgRef[] = []
  let pageToken: string | undefined
  do {
    const params: Record<string, string> = {
      maxResults: "500",
      q: `after:${afterSec} before:${beforeSec} -in:spam -in:trash`,
    }
    if (pageToken) params.pageToken = pageToken
    const res = (await get("/messages", params, gmailUser)) as {
      messages?: Array<{ id: string; threadId: string }>
      nextPageToken?: string
    }
    for (const m of res.messages ?? []) out.push({ id: m.id, threadId: m.threadId })
    pageToken = res.nextPageToken
  } while (pageToken)
  return out
}

/** Which of `ids` are already stored 'complete' (chunked IN, never a full-set load). */
export async function completedAmong(mailbox: Mailbox, ids: string[]): Promise<Set<string>> {
  assertMailbox(mailbox)
  const done = new Set<string>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const { data, error } = await db
      .from("email_message_content")
      .select("message_id")
      .eq("mailbox", mailbox)
      .eq("capture_status", "complete")
      .in("message_id", chunk)
    if (error) throw new Error(`completedAmong failed: ${error.message}`)
    for (const r of (data ?? []) as Array<{ message_id: string }>) done.add(r.message_id)
  }
  return done
}

export interface ReconcileTally {
  mailbox: Mailbox
  inGmail: number
  alreadyStored: number
  missing: number
  repaired: number
  error: number
}

export interface ReconcileIO {
  list: (gmailUser: string, afterSec: number, beforeSec: number) => Promise<MsgRef[]>
  completed: (mailbox: Mailbox, ids: string[]) => Promise<Set<string>>
  capture: (args: { mailbox: Mailbox; messageId: string; threadId: string }) => Promise<CaptureResult>
}

/**
 * Reconcile one date window for one mailbox: everything Gmail has must be stored
 * complete; capture whatever's missing. Returns what it found and healed.
 */
export async function reconcileWindow(
  opts: { mailbox: Mailbox; afterSec: number; beforeSec: number; concurrency?: number },
  io?: ReconcileIO,
): Promise<ReconcileTally> {
  assertMailbox(opts.mailbox)
  if (!(opts.afterSec < opts.beforeSec)) {
    throw new Error("reconcileWindow: afterSec must be < beforeSec")
  }
  const resolved: ReconcileIO = io ?? {
    list: (user, a, b) => listMessageIdsInWindow(user, a, b),
    completed: (mb, ids) => completedAmong(mb, ids),
    capture: (args) => captureMessageContent(args, buildCaptureDeps(opts.mailbox)),
  }

  const refs = await resolved.list(MAILBOX_USER[opts.mailbox], opts.afterSec, opts.beforeSec)
  const done = await resolved.completed(opts.mailbox, refs.map((r) => r.id))
  const missing = refs.filter((r) => !done.has(r.id))

  const tally: ReconcileTally = {
    mailbox: opts.mailbox, inGmail: refs.length, alreadyStored: refs.length - missing.length,
    missing: missing.length, repaired: 0, error: 0,
  }
  await drainPool(missing, opts.concurrency ?? 8, async (ref) => {
    const res = await resolved.capture({ mailbox: opts.mailbox, messageId: ref.id, threadId: ref.threadId })
    if (res.status === "complete" || res.status === "skipped") tally.repaired++
    else tally.error++
  })
  return tally
}
