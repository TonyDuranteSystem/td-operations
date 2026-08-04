import { NextRequest, NextResponse } from "next/server"
import { purgeExpired, purgeIO, BIN_RETENTION_DAYS } from "@/lib/email-store/deletion"

export const dynamic = "force-dynamic"
export const maxDuration = 120

/**
 * GET /api/cron/email-bin-purge — daily.
 *
 * Empties the bin: permanently removes our stored copy (body + attachments) of
 * messages deleted more than BIN_RETENTION_DAYS ago, plus anything flagged
 * "delete forever". Until then a deleted email stays readable from our copy —
 * Gmail drops its own Trash at ~30 days, so past that ours is the only copy,
 * which is the whole point of the 180-day bin (Antonio 2026-08-02).
 *
 * Bounded per run (200 messages) so a large backlog drains over several days
 * instead of one heavy sweep; storage is removed before the row so a crash can
 * never strand bytes with no pointer to them.
 */
export async function GET(request: NextRequest) {
  // FAILS CLOSED, unlike the sibling email crons. Those use the
  // `if (CRON_SECRET && ...)` form, so a missing secret leaves them open — the
  // worst case there is an extra read. This route permanently destroys email,
  // so an unset secret must refuse, not wave everyone through (security review,
  // 2026-08-04).
  const authHeader = request.headers.get("authorization")
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const tally = await purgeExpired(Date.now(), purgeIO)
    if (tally.errors > 0) {
      // A silently-failing purge is invisible otherwise: the tally lands in a
      // JSON response nobody reads, while bytes we promised to destroy remain.
      const { reportSystemError } = await import("@/lib/system-errors")
      await reportSystemError({
        source: "server" as const,
        route: "/api/cron/email-bin-purge",
        method: "GET",
        message: `email bin purge: ${tally.errors} of ${tally.examined} messages failed to erase`,
        context: { ...tally },
      })
    }
    return NextResponse.json({ ok: true, retentionDays: BIN_RETENTION_DAYS, ...tally })
  } catch (err) {
    console.error("[email-bin-purge] failed:", err)
    return NextResponse.json({ error: "purge failed" }, { status: 500 })
  }
}
