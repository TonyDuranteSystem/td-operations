import { NextRequest, NextResponse } from "next/server"
import { captureBatchLive } from "@/lib/email-store/worker"

export const dynamic = "force-dynamic"
export const maxDuration = 120

/**
 * GET /api/cron/email-content-capture — every 10 min, always on.
 *
 * Keeps NEW mail copied going forward: captures the body + attachments of the
 * newest not-yet-stored messages in each mailbox. Small, bounded batches, so it
 * is safe to run during the workday (new mail is low volume — unlike the one-time
 * history backfill, which stays off-hours). Insert-once, so it never re-downloads
 * already-stored mail and never collides with the off-hours history backfill.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Runs ANY time (including weekends — the inbox is used 7 days a week, so a
  // clock-based pause is the wrong lever). Instead this is deliberately GENTLE:
  // INCIDENT 2026-08-02 — capturing 50 msgs at concurrency 5 alongside the live
  // inbox exhausted the per-user Gmail quota and the whole inbox rendered
  // "Couldn't load — retrying". Fix: SEQUENTIAL (concurrency 1) and a small
  // batch, so capture uses a thin slice of the 250 units/user/sec and the
  // interactive inbox always has headroom. New mail still lands within minutes.
  const results: Record<string, unknown> = {}
  for (const mailbox of ["support", "antonio"] as const) {
    try {
      results[mailbox] = await captureBatchLive(mailbox, 15, 1)
    } catch (err) {
      results[mailbox] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  return NextResponse.json({ ok: true, results })
}
