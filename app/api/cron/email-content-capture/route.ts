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

  // ── PAUSED 2026-08-02 (incident) ──────────────────────────────────────────
  // The CRM inbox renders a page by fetching metadata for up to 300 threads
  // LIVE from Gmail (app/api/inbox/conversations/route.ts) — ~3,000 quota units
  // per page load, i.e. it already needs most of the 250 units/user/sec burst.
  // Any concurrent capture (even sequential) tips it over and the whole inbox
  // renders "Couldn't load — retrying". Throttling was not enough.
  //
  // Capture stays OFF until the inbox READS from our local store instead of
  // live Gmail (the read-repoint leg). At that point the inbox stops competing
  // for quota and capture can resume safely. Re-enable by deleting this block.
  return NextResponse.json({ skipped: "paused-until-read-repoint" })

  // eslint-disable-next-line no-unreachable
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
