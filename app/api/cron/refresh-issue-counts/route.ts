/**
 * GET /api/cron/refresh-issue-counts — nightly refresh of the per-client issue
 * cache that powers the Portal Chats ⚠️ indicators. Runs the shared client
 * diagnostic (same code the Issues tab shows) for every client that has a portal
 * chat, and upserts the error/warning counts into client_issue_counts.
 *
 * Bounded to clients with portal messages (not all accounts). CRON_SECRET-authed.
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { refreshIssueCount } from "@/lib/diagnostics/refresh-issue-count"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now = new Date().toISOString()

  // Clients that actually have a portal chat — the set the Portal Chats list shows.
  const { data: rows } = await db
    .from("portal_messages")
    .select("account_id")
    .not("account_id", "is", null)
  const accountIds = Array.from(
    new Set((rows || []).map((r: { account_id: string }) => r.account_id).filter(Boolean)),
  ) as string[]

  let ok = 0
  let failed = 0
  for (const accountId of accountIds) {
    try {
      await refreshIssueCount(accountId, now)
      ok++
    } catch {
      failed++
    }
  }

  return NextResponse.json({ ok: true, refreshed: ok, failed, total: accountIds.length })
}
