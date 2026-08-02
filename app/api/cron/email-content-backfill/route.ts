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

  // Off-hours only (13:00–23:00 UTC ≈ US business hours). INCIDENT 2026-08-02:
  // running the pull during business hours starved the interactive inbox's
  // per-user Gmail quota — the whole inbox showed "Couldn't load — retrying".
  // The pull shares the SAME per-user quota as the live inbox, so it must run
  // off-hours (same guard the metadata backfill uses). It still completes over
  // a night or two; the inbox falls back to live Gmail meanwhile.
  const utcHour = new Date().getUTCHours()
  if (utcHour >= 13 && utcHour < 23) {
    return NextResponse.json({ skipped: "business-hours" })
  }

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
