/**
 * Zoom recordings → CRM storage (TD Marketing, dev job 9aec66fa). Every 15 minutes: ask Zoom for the new finished cloud recordings of the marketing logins and file them under Business › Zoom Calls › the marketing folder.
 * Auth: CRON_SECRET Bearer. Schedule: vercel.json (kept in sync with lib/cron-coverage.ts). Without Zoom keys, an active team or the folder it does nothing and says why.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { logCron } from "@/lib/cron-log"
import { liveSyncSetup } from "@/lib/marketing/zoom-recordings-live"
import { syncRecordings } from "@/lib/marketing/zoom-recordings"

const ENDPOINT = "/api/cron/zoom-recordings"

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return authHeader === null || authHeader === "Bearer "
  return authHeader === `Bearer ${cronSecret}`
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const setup = await liveSyncSetup()
    if (setup.ok === false) return NextResponse.json({ ok: true, skipped: setup.reason })
    const report = await syncRecordings(setup.deps)
    const bad = report.failed.length > 0 || report.tooBig.length > 0
    logCron({ endpoint: ENDPOINT, status: bad ? "error" : "success", duration_ms: Date.now() - start, ...(bad ? { error_message: `${report.failed.length} failed, ${report.tooBig.length} too big` } : {}), details: { ...report } })
    return NextResponse.json({ ok: !bad, report })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - start, error_message: message })
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
