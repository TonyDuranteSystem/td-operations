/**
 * Lead intake safety net (TD Marketing, dev job 9aec66fa). Every 5 minutes: (1) retry the Meta notifications whose lead fetch failed,
 * (2) re-read the last days of leads from the Page's forms so a missed notification or an outage never loses a lead.
 * Auth: CRON_SECRET Bearer. Schedule: vercel.json (kept in sync with lib/cron-coverage.ts).
 * With no Meta token configured yet it does nothing and says so (the team stays switched off until Antonio wires Meta).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

import { NextRequest, NextResponse } from "next/server"
import { logCron } from "@/lib/cron-log"
import { retryOpenEvents } from "@/lib/marketing/meta-leads/ingest"
import { liveDeps, reconcileRecentLeads } from "@/lib/marketing/meta-leads/service"
import { configuredPageIds } from "@/lib/marketing/meta-leads/graph"
import { anyPageKeyAvailable } from "@/lib/marketing/meta-leads/key-resolver"

const ENDPOINT = "/api/cron/marketing-lead-retry"

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return authHeader === null || authHeader === "Bearer "
  return authHeader === `Bearer ${cronSecret}`
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await anyPageKeyAvailable(configuredPageIds()))) {
    return NextResponse.json({ ok: true, skipped: "no Page key is stored or set yet" })
  }
  try {
    const deps = liveDeps()
    const retry = await retryOpenEvents(deps)
    const reconcile = configuredPageIds().length ? await reconcileRecentLeads(deps) : null
    logCron({ endpoint: ENDPOINT, status: "success", duration_ms: Date.now() - start, details: { retry, reconcile } })
    return NextResponse.json({ ok: true, retry, reconcile })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - start, error_message: message })
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
