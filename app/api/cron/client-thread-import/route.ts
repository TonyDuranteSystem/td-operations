/**
 * One-shot: import the open Slack-sourced client conversations into Team Chat.
 *
 * Runs here rather than from a laptop because the Slack key lives in the deployment.
 * Not scheduled — a person runs it and reads the report.
 *
 * GET  → DRY RUN. Reads, writes nothing, reports what it would import.
 * POST → creates the Team Chat threads and their messages.
 *
 * Auth: the deployment's cron secret, OR a signed-in admin.
 */

export const dynamic = "force-dynamic"
// A hundred-odd conversations, each one or more Slack reads plus the inserts.
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { importClientConversations } from "@/lib/team/import-client-conversations"

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
  const report = await importClientConversations({ dryRun, ...(limit ? { limit } : {}) })
  return NextResponse.json(report)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return run(req, true)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return run(req, false)
}
