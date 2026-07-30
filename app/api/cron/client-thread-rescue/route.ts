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
 * Auth: CRON_SECRET Bearer, same as the other /api/cron routes.
 */

export const dynamic = "force-dynamic"
// A hundred-odd threads, each one or more Slack calls plus a name lookup.
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { rescueClientThreads } from "@/lib/ai-agent/client-thread-rescue"

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  return authHeader === `Bearer ${cronSecret}`
}

async function run(req: NextRequest, dryRun: boolean): Promise<NextResponse> {
  if (!isAuthorized(req)) {
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
