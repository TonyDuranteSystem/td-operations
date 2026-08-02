import { NextRequest, NextResponse } from "next/server"
import { runBackfillTick, backfillTickIO, backfillProgress } from "@/lib/email-store/auto-backfill"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * GET /api/cron/email-content-backfill — off-hours, self-chaining.
 *
 * Automatic one-time download of every email's body + attachments into our own
 * store. Each run walks a few date-windows backward from a saved cursor (per
 * mailbox), captures whatever Gmail has that we don't, and exits before the
 * function's time limit; the next run resumes. Resumable + idempotent, so it
 * just keeps going overnight until every email is stored — no human step, always
 * on. Runs OFF-HOURS only (shares each mailbox's Gmail quota with the live inbox);
 * when a mailbox is fully walked it marks itself done and later ticks no-op.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Runs ANY time, including weekends (the inbox is used 7 days a week, so a
  // clock-based pause is the wrong lever — Antonio 2026-08-02, Sunday).
  // INCIDENT 2026-08-02: the pull shares the SAME per-user Gmail quota as the
  // interactive inbox; running it hot made the whole inbox render "Couldn't
  // load — retrying". Fix is THROTTLE, not a curfew: a short budget per tick +
  // low in-window concurrency (see backfillTickIO) leave the live inbox ample
  // headroom. It finishes in more, smaller ticks instead of few greedy ones.

  // RESUMED 2026-08-02 (Antonio: "switched back on"). Safe now: the inbox
  // list and search read from our own index, so they no longer spend ~3,000
  // Gmail quota units per page and capture is not competing with them. Kept
  // deliberately gentle regardless — see the batch/budget settings below.
  const results: Record<string, unknown> = {}
  for (const mailbox of ["support", "antonio"] as const) {
    try {
      const tick = await runBackfillTick({ mailbox, budgetMs: 60_000 }, backfillTickIO)
      const progress = await backfillProgress(mailbox)
      results[mailbox] = { tick, progress }
    } catch (err) {
      results[mailbox] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  return NextResponse.json({ ok: true, results })
}
