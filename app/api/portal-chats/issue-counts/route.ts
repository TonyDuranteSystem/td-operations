/**
 * GET /api/portal-chats/issue-counts — per-account cached issue counts for the
 * Portal Chats list (feeds the ⚠️ indicator, the top total, and the Issues
 * filter). Reads the cheap cache (client_issue_counts); never runs the live
 * diagnostic. Staff-only.
 *
 * POST /api/portal-chats/issue-counts { account_id } — on-demand refresh for one
 * account (called when a client's Issues tab is opened) so the cache is fresh.
 */
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { refreshIssueCount } from "@/lib/diagnostics/refresh-issue-count"

// client_issue_counts isn't in the generated types yet (new table).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const { data } = await db
    .from("client_issue_counts")
    .select("account_id, error_count, warning_count")
    .or("error_count.gt.0,warning_count.gt.0")

  const counts: Record<string, { error: number; warning: number }> = {}
  for (const r of (data || []) as Array<{ account_id: string; error_count: number; warning_count: number }>) {
    counts[r.account_id] = { error: r.error_count, warning: r.warning_count }
  }
  return NextResponse.json({ counts })
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  let body: { account_id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.account_id) {
    return NextResponse.json({ error: "Missing account_id" }, { status: 400 })
  }

  const count = await refreshIssueCount(body.account_id, new Date().toISOString())
  return NextResponse.json({ ok: true, count })
}
