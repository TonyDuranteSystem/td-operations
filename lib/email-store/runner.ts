/**
 * Own-Inbox one-time HISTORICAL backfill runner (dev_task 01800da8).
 *
 * The fastest fully-automatic download (council 2026-08-01, ~10 min end-to-end):
 *  - enumerate ALL message ids via messages.list (5 units, 500/page) — seconds.
 *  - drain them through captureMessageContent with a BOUNDED CONCURRENCY pool
 *    (~10-12 in-flight saturates a mailbox's 250-units/s quota).
 *  - both mailboxes run in parallel (independent per-user quotas).
 *  - insert-once: already-'complete' messages are skipped, so the runner is
 *    fully resumable — a crash re-runs and only picks up what's missing.
 *
 * This does the HEAVY one-time load. Ongoing new mail is the incremental worker.
 * Runs against LIVE Gmail (production creds) — NOT exercisable in sandbox. IO is
 * dependency-injected so the enumerate/pool logic is unit-tested without Gmail.
 */
import { gmailGet } from "@/lib/gmail"
import { captureMessageContent, type CaptureResult } from "./capture"
import { buildCaptureDeps, MAILBOX_USER } from "./worker"
import { assertMailbox, type Mailbox } from "./paths"

export interface MsgRef {
  id: string
  threadId: string
}

/** Enumerate every message id in a mailbox via messages.list (paged 500). */
export async function enumerateMessageIds(
  gmailUser: string,
  get: (endpoint: string, params?: Record<string, string>, asUser?: string) => Promise<any> = gmailGet,
): Promise<MsgRef[]> {
  const out: MsgRef[] = []
  let pageToken: string | undefined
  do {
    const params: Record<string, string> = { maxResults: "500" }
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

/** Drain `items` through `work` with at most `concurrency` in flight. */
export async function drainPool<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const conc = Math.max(1, concurrency)
  let next = 0
  async function runner(): Promise<void> {
    while (next < items.length) {
      const item = items[next++]
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, runner))
}

export interface BackfillTally {
  mailbox: Mailbox
  enumerated: number
  complete: number
  skipped: number
  error: number
}

export interface BackfillIO {
  enumerate: (gmailUser: string) => Promise<MsgRef[]>
  capture: (args: { mailbox: Mailbox; messageId: string; threadId: string }) => Promise<CaptureResult>
}

/** Run the full historical backfill for ONE mailbox. Resumable + idempotent. */
export async function runFullBackfill(
  opts: { mailbox: Mailbox; concurrency?: number },
  io?: BackfillIO,
): Promise<BackfillTally> {
  assertMailbox(opts.mailbox)
  const concurrency = opts.concurrency ?? 10
  const resolvedIo: BackfillIO = io ?? {
    enumerate: (user) => enumerateMessageIds(user),
    capture: (args) => captureMessageContent(args, buildCaptureDeps(opts.mailbox)),
  }
  const refs = await resolvedIo.enumerate(MAILBOX_USER[opts.mailbox])
  const tally: BackfillTally = { mailbox: opts.mailbox, enumerated: refs.length, complete: 0, skipped: 0, error: 0 }
  await drainPool(refs, concurrency, async (ref) => {
    const res = await resolvedIo.capture({ mailbox: opts.mailbox, messageId: ref.id, threadId: ref.threadId })
    if (res.status === "complete") tally.complete++
    else if (res.status === "skipped") tally.skipped++
    else tally.error++
  })
  return tally
}

/** Run BOTH mailboxes in parallel (independent per-user Gmail quotas). */
export async function runFullBackfillAllMailboxes(
  concurrencyPerMailbox = 10,
): Promise<BackfillTally[]> {
  return Promise.all(
    (["support", "antonio"] as Mailbox[]).map((mailbox) =>
      runFullBackfill({ mailbox, concurrency: concurrencyPerMailbox }),
    ),
  )
}
