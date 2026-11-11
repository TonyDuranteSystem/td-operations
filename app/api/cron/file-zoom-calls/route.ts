/**
 * File Zoom call folders → TD Zoom Calls › year › month (dev job 1f4645b6). Every 10 minutes: look at the folders at the top of Business › Zoom Calls and file each
 * finished call (quiet for 10 minutes, no upload open) into TD Zoom Calls — or TD Marketing Calls for a marketing-link booking. Switch: app_settings.zoom_call_filing
 * ("off" | "dry_run" | "live"; missing = off). Auth: CRON_SECRET Bearer. Schedule: vercel.json (kept in sync with lib/cron-coverage.ts).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { logCron } from "@/lib/cron-log"
import { fileZoomCalls, liveFilingDeps } from "@/lib/crm-store/zoom-call-filing"

const ENDPOINT = "/api/cron/file-zoom-calls"

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
    const report = await fileZoomCalls(liveFilingDeps())
    if (report.skipped) return NextResponse.json({ ok: true, skipped: report.skipped, mode: report.mode })
    const bad = report.failed.length > 0
    // a quiet run (nothing to file, nothing wrong) leaves no log row: it runs every 10 minutes
    if (bad || report.filed.length > 0) {
      logCron({ endpoint: ENDPOINT, status: bad ? "error" : "success", duration_ms: Date.now() - start, ...(bad ? { error_message: `${report.failed.length} failed: ${report.failed[0].name}` } : {}), details: { ...report } })
    }
    return NextResponse.json({ ok: !bad, report })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - start, error_message: message })
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
