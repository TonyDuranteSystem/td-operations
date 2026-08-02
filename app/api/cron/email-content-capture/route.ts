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

  // INCIDENT 2026-08-02: running content capture during business hours starved
  // the interactive inbox's per-user Gmail quota (all emails showed "Couldn't
  // load — retrying"). Paused during US business hours (13:00–23:00 UTC) — the
  // exact starvation guard the metadata backfill already uses. New mail is
  // captured off-hours; the small ~10-min catch-up delay is worth not fighting
  // the live inbox.
  const utcHour = new Date().getUTCHours()
  if (utcHour >= 13 && utcHour < 23) {
    return NextResponse.json({ skipped: "business-hours" })
  }

  const results: Record<string, unknown> = {}
  for (const mailbox of ["support", "antonio"] as const) {
    try {
      // Small batch: catch up recent new mail without competing with the live inbox.
      results[mailbox] = await captureBatchLive(mailbox, 50, 5)
    } catch (err) {
      results[mailbox] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  return NextResponse.json({ ok: true, results })
}
