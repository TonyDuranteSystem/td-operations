/**
 * Mercury transaction sync — configurable date range.
 * Default: 30 days. Use ?days=N to override.
 *
 * Replaces Plaid for Mercury — direct API gives full sender name, memo, reference.
 * Call manually or via Vercel Cron (every 15 min recommended).
 *
 * PR C: after a successful sync that added new feeds, run
 * processBankFeedMatches() to auto-match + auto-activate. The match step is
 * idempotent and safe even when `added=0`, but skipping that case avoids
 * needless DB scans.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { syncMercuryTransactions } from "@/lib/mercury-sync"
import { logCron } from "@/lib/cron-log"
import { processBankFeedMatches, type ProcessBankFeedMatchesResult } from "@/lib/operations/process-bank-feed-matches"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const daysBack = parseInt(req.nextUrl.searchParams.get("days") ?? "30", 10)
  const from = new Date(Date.now() - daysBack * 86400000).toISOString().split("T")[0]
  const to = new Date().toISOString().split("T")[0]

  try {
    const result = await syncMercuryTransactions(from, to)

    // PR C: trigger auto-match + auto-activate on the unmatched batch.
    let matchResult: ProcessBankFeedMatchesResult | { error: string } | null = null
    if (result.added > 0) {
      try {
        matchResult = await processBankFeedMatches()
      } catch (matchErr) {
        const msg = matchErr instanceof Error ? matchErr.message : String(matchErr)
        console.error("[mercury-sync] processBankFeedMatches failed:", msg)
        matchResult = { error: msg }
      }
    }

    logCron({
      endpoint: "/api/cron/mercury-sync",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { from, to, ...result, match: matchResult },
    })
    return NextResponse.json({ ok: true, from, to, ...result, match: matchResult })
  } catch (err) {
    const msg = (err as Error).message
    logCron({
      endpoint: "/api/cron/mercury-sync",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: msg,
    })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
