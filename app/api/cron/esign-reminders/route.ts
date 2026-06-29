/**
 * GET /api/cron/esign-reminders — Bearer CRON_SECRET. Expires overdue envelopes
 * and nudges invited-but-unsigned signers. Logic in lib/esign/reminders.ts.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { logCron } from "@/lib/cron-log"
import { runEsignReminders } from "@/lib/esign/reminders"

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const start = Date.now()
  try {
    const results = await runEsignReminders(new Date())
    logCron({ endpoint: "/api/cron/esign-reminders", status: "success", duration_ms: Date.now() - start, details: results })
    return NextResponse.json({ ok: true, ...results })
  } catch (err) {
    logCron({ endpoint: "/api/cron/esign-reminders", status: "error", duration_ms: Date.now() - start, error_message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
