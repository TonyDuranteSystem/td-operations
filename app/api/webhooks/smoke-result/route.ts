/**
 * Webhook endpoint: smoke-result (P2.6 / I3)
 *
 * Called by .github/workflows/post-deploy-smoke.yml on EVERY run (pass
 * OR fail) to persist the per-deploy smoke outcome into
 * deploy_smoke_results. Plan §4 line 574: "Results written to a new
 * deploy_smoke_results table surfaced in /system-health."
 *
 * Why a separate endpoint from smoke-alert:
 *   - smoke-alert sends emails on failure only.
 *   - smoke-result ALWAYS writes a row so P2.8 can show the "last N
 *     deploys were all green" history, not just the failures.
 * Two small single-purpose routes are easier to reason about than one
 * branchy endpoint.
 *
 * Path under /api/webhooks/ so middleware.ts PUBLIC_PREFIXES (line 22)
 * exempts it — same rationale as smoke-alert.
 *
 * Auth: Bearer CRON_SECRET (shared with smoke-alert + audit-health-check
 * cron; no new secret needed in GH Actions).
 */

export const dynamic = "force-dynamic"
export const maxDuration = 10

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

interface SmokeCheck {
  check: string
  url: string
  status: string
  result: "pass" | "fail"
  expected?: string
  actual?: string
  error?: string
}

interface SmokeResultBody {
  commit_sha: string
  workflow_run_url?: string
  checks: SmokeCheck[]
  checked_at?: string
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: "Server misconfigured: CRON_SECRET not set" }, { status: 500 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: SmokeResultBody
  try {
    body = (await req.json()) as SmokeResultBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (typeof body.commit_sha !== "string" || !body.commit_sha) {
    return NextResponse.json({ error: "commit_sha required" }, { status: 400 })
  }
  if (!Array.isArray(body.checks)) {
    return NextResponse.json({ error: "checks[] required" }, { status: 400 })
  }

  const failureCount = body.checks.filter(c => c.result === "fail").length
  const anyFailed = failureCount > 0

  const { data, error } = await supabaseAdmin
    .from("deploy_smoke_results")
    .insert({
      commit_sha: body.commit_sha,
      workflow_run_url: body.workflow_run_url ?? null,
      checks: body.checks as unknown as never, // jsonb; shape validated by caller
      any_failed: anyFailed,
      failure_count: failureCount,
      checked_at: body.checked_at ? new Date(body.checked_at).toISOString() : new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error) {
    return NextResponse.json({ error: "DB insert failed", detail: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    id: data.id,
    any_failed: anyFailed,
    failure_count: failureCount,
  })
}
