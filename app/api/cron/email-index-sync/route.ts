import { NextRequest, NextResponse } from "next/server"
import { backfillStep, syncIncremental, MAILBOX_ADDRESSES } from "@/lib/email-index/sync"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// gmail_watch_state extra columns not in generated types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/**
 * GET /api/cron/email-index-sync — every 10 min.
 *
 * Two jobs per mailbox:
 *  1. BACKFILL: while not done, index the next page of mailbox history
 *     (resumable cursor in gmail_watch_state) — the one-time full build.
 *  2. RECONCILE: incremental history sync as a safety net behind the
 *     gmail-push-driven sync (heals missed pushes / expired cursors).
 *
 * Runs in BOTH environments: sandbox and production each maintain their own
 * index of the same mailboxes (reads only — no webhook registration here).
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const results: Record<string, unknown> = {}
  const startedAt = Date.now()

  // The one-time backfill makes ~180 live Gmail calls per page on the SAME
  // mailbox the interactive inbox reads. Running it hard during the workday
  // starved Gmail's per-user quota and made the inbox slow/flaky (Antonio
  // 2026-07-08). So: PAUSE backfill during US business hours (13:00–23:00
  // UTC ≈ 9am–7pm ET) and cap it to ONE page/run otherwise — the rebuild
  // just takes longer (overnight), and every index-backed surface falls back
  // to live Gmail until it completes, so there is zero correctness cost.
  // The light incremental reconcile still runs whenever backfill is done.
  const utcHour = new Date().getUTCHours()
  const inBusinessHours = utcHour >= 13 && utcHour < 23
  const maxBackfillPages = inBusinessHours ? 0 : 1

  for (const mailbox of ["support", "antonio"] as const) {
    try {
      // One backfill page per run off business hours; none during them.
      let bf: { indexedThreads: number; indexedMessages: number; done: boolean } = {
        indexedThreads: 0,
        indexedMessages: 0,
        done: false,
      }
      let pages = 0
      while (pages < maxBackfillPages && !bf.done && Date.now() - startedAt < 60_000) {
        const next = await backfillStep(mailbox)
        bf = {
          indexedThreads: bf.indexedThreads + next.indexedThreads,
          indexedMessages: bf.indexedMessages + next.indexedMessages,
          done: next.done,
        }
        pages += 1
      }
      // If backfill was skipped this run, reflect the persisted done-state so
      // the reconcile branch still fires once the rebuild has completed.
      if (pages === 0) {
        const { data: st } = await db
          .from("gmail_watch_state")
          .select("backfill_done")
          .eq("mailbox", mailbox)
          .maybeSingle()
        bf.done = st?.backfill_done === true
      }
      let sync: { threads: number } | null = null
      if (bf.done) {
        // Reconcile from the current profile historyId
        const profile = (await import("@/lib/gmail").then(({ gmailGet }) =>
          gmailGet("/profile", undefined, MAILBOX_ADDRESSES[mailbox])
        )) as { historyId?: string }
        if (profile.historyId) {
          sync = await syncIncremental(mailbox, String(profile.historyId))
        }
      }
      results[mailbox] = { backfill: bf, reconcile: sync }
    } catch (err) {
      results[mailbox] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  const { count } = await db
    .from("email_index")
    .select("id", { count: "exact", head: true })
  results.total_indexed = count ?? null

  return NextResponse.json({ ok: true, results })
}
