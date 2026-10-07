/**
 * GET /api/cron/esign-reminders — Bearer CRON_SECRET. Expires overdue envelopes
 * and nudges invited-but-unsigned signers. Logic in lib/esign/reminders.ts.
 * Also sweeps abandoned E-Sign upload staging files (>24 h) — lib/esign/staging.ts.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { logCron } from "@/lib/cron-log"
import { runEsignReminders } from "@/lib/esign/reminders"
import { sweepEsignStaging } from "@/lib/esign/staging"

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const start = Date.now()
  try {
    const results = await runEsignReminders(new Date())
    // Housekeeping only — it never throws and must not turn a good reminder run into a failure.
    const staging = await sweepEsignStaging(new Date())
    logCron({ endpoint: "/api/cron/esign-reminders", status: "success", duration_ms: Date.now() - start, details: { ...results, staging_swept: staging.removed, staging_error: staging.error } })
    return NextResponse.json({ ok: true, ...results, staging_swept: staging.removed })
  } catch (err) {
    logCron({ endpoint: "/api/cron/esign-reminders", status: "error", duration_ms: Date.now() - start, error_message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
