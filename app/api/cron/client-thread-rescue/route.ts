/**
 * One-shot: copy every open client conversation out of Slack into our own database.
 *
 * Runs here rather than as a local script because the Slack token lives in the
 * deployment's environment, not on anyone's machine. Not on a schedule — it is
 * triggered by hand, is idempotent, and reports exactly what it did.
 *
 * GET  → DRY RUN. Reads Slack, writes nothing, reports what would be archived.
 * POST → writes the archives.
 *
 * Auth: the deployment's cron secret, OR a signed-in admin.
 */

export const dynamic = "force-dynamic"
// A hundred-odd threads, each one or more Slack calls plus a name lookup.
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { rescueClientThreads } from "@/lib/ai-agent/client-thread-rescue"

/**
 * Either the deployment's own cron secret, or a signed-in ADMIN.
 *
 * The admin path exists because this is a one-shot a person runs and watches, not a
 * schedule: the alternative is copying a production secret onto a laptop to curl it,
 * which is a worse thing to do than letting the one person who may already read every
 * client conversation press the button from a browser. Admin, not any staff member —
 * it writes. /api/cron is a public prefix in middleware, so the session cookie reaches
 * this handler and the check happens here rather than at the edge.
 */
async function isAuthorized(req: NextRequest): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && req.headers.get("authorization") === `Bearer ${cronSecret}`) return true
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    return isAdmin(user)
  } catch {
    return false
  }
}

async function run(req: NextRequest, dryRun: boolean): Promise<NextResponse> {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  const limitParam = req.nextUrl.searchParams.get("limit")
  const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam) || 0)) : undefined
  const report = await rescueClientThreads({ dryRun, ...(limit ? { limit } : {}) })
  return NextResponse.json(report)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return run(req, true)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return run(req, false)
}
