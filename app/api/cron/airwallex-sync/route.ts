/**
 * Airwallex deposit sync — configurable date range.
 * Default: 90 days. Use ?days=N to override.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { syncAirwallexDeposits } from "@/lib/airwallex-sync"

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const daysBack = parseInt(req.nextUrl.searchParams.get("days") ?? "90", 10)
  const from = new Date(Date.now() - daysBack * 86400000).toISOString().split("T")[0]
  const to = new Date().toISOString().split("T")[0]

  try {
    const result = await syncAirwallexDeposits(from, to)
    return NextResponse.json({ ok: true, from, to, ...result })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 })
  }
}
