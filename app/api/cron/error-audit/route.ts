/**
 * GET /api/cron/error-audit — AI diagnosis pass over captured system errors.
 * Runs every 15 minutes via Vercel Cron (vercel.json + lib/cron-coverage.ts).
 *
 * Picks up to BATCH_SIZE rows in status 'open', asks the shared AI provider
 * for a plain-English diagnosis + suggested fix, and writes both back to the
 * row (status → 'diagnosed'). Rows it cannot diagnose stay 'open' for the
 * next pass. Results are surfaced on /system-health.
 */

import { NextRequest, NextResponse } from "next/server"
import { diagnoseSystemError, listSystemErrors } from "@/lib/system-errors"
import { logCron } from "@/lib/cron-log"

export const maxDuration = 300

const BATCH_SIZE = 5

export async function GET(request: NextRequest) {
  const startTime = Date.now()
  const authHeader = request.headers.get("authorization")
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const rows = await listSystemErrors({ statuses: ["open"], limit: BATCH_SIZE })
    let diagnosed = 0
    for (const row of rows) {
      if (await diagnoseSystemError(row)) diagnosed++
    }

    logCron({
      endpoint: "/api/cron/error-audit",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { picked: rows.length, diagnosed },
    })
    return NextResponse.json({ success: true, picked: rows.length, diagnosed })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    logCron({
      endpoint: "/api/cron/error-audit",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: message,
    })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
