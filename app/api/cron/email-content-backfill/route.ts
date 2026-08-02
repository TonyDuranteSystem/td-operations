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

  // Runs ANY hour (Antonio 2026-08-02: start now, don't wait for tonight). The
  // whole one-time pull is ~10 min and paces itself (concurrency-8 ≈ 80% of the
  // per-user Gmail quota, leaving headroom for the interactive inbox), so the
  // business-hours pause the multi-day METADATA backfill needs isn't warranted
  // here. Once each mailbox is fully walked it marks itself done and no-ops.

  // ~120s budget per mailbox keeps the whole run under the 300s function cap.
  const results: Record<string, unknown> = {}
  for (const mailbox of ["support", "antonio"] as const) {
    try {
      const tick = await runBackfillTick({ mailbox, budgetMs: 120_000 }, backfillTickIO)
      const progress = await backfillProgress(mailbox)
      results[mailbox] = { tick, progress }
    } catch (err) {
      results[mailbox] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  return NextResponse.json({ ok: true, results })
}
