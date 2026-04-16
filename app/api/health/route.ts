/**
 * Health endpoint — P2.7 (plan §4 line 576)
 *
 * Minimal "is this deploy alive" probe. Runs a few sanity queries and
 * returns 200 + compact JSON on OK, 503 + diagnostic JSON on failure.
 * Plan requires this endpoint so the post-deploy smoke (P2.6) can
 * distinguish "deploy landed" from "deploy serving broken".
 *
 * No auth — this IS the liveness probe; anything that needs auth is
 * not a health check. Safe to expose publicly because the checks only
 * read 2 counts and never echo client data. `/api/health` is added to
 * middleware.ts PUBLIC_PREFIXES so it returns 200 instead of redirecting
 * to /login.
 *
 * What's checked (minimal surface, fast):
 *   1. Required env vars are set.
 *   2. Supabase reachability — count(*) on a known-tiny table (public
 *      pg_catalog roundtrip would also work; using `dev_tasks` count
 *      exercises the actual data path the app uses).
 *
 * Explicitly NOT checked here (belongs in deeper probes):
 *   - Third-party APIs (Gmail, QB, Drive) — too flaky for a liveness
 *     probe; Sentry covers runtime failures.
 *   - Cron freshness — covered by P2.10 cron coverage audit.
 *   - Audit findings — covered by P2.6 smoke + the audit-health-check
 *     cron itself.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 10

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

interface CheckResult {
  name: string
  ok: boolean
  detail?: string
  elapsed_ms?: number
}

export async function GET() {
  const startedAt = Date.now()
  const checks: CheckResult[] = []

  // ─── Check 1: required env vars present ─────────────────────
  const envCheckStart = Date.now()
  const missing: string[] = []
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY")
  checks.push({
    name: "env",
    ok: missing.length === 0,
    detail: missing.length === 0 ? "all required vars set" : `missing: ${missing.join(", ")}`,
    elapsed_ms: Date.now() - envCheckStart,
  })

  // ─── Check 2: Supabase reachability via tiny count ──────────
  const dbCheckStart = Date.now()
  try {
    const { error } = await supabaseAdmin
      .from("dev_tasks")
      .select("id", { count: "exact", head: true })
      .limit(1)

    if (error) {
      checks.push({
        name: "db",
        ok: false,
        detail: `supabase error: ${error.message}`,
        elapsed_ms: Date.now() - dbCheckStart,
      })
    } else {
      checks.push({
        name: "db",
        ok: true,
        detail: "supabase reachable",
        elapsed_ms: Date.now() - dbCheckStart,
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    checks.push({
      name: "db",
      ok: false,
      detail: `supabase threw: ${msg}`,
      elapsed_ms: Date.now() - dbCheckStart,
    })
  }

  const allOk = checks.every(c => c.ok)
  const body = {
    ok: allOk,
    checks,
    elapsed_ms: Date.now() - startedAt,
    // Deployed commit, useful when debugging "is the new code live?"
    // VERCEL_GIT_COMMIT_SHA is set by Vercel at deploy time; locally it's undefined.
    commit_sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local",
    timestamp: new Date().toISOString(),
  }

  return NextResponse.json(body, { status: allOk ? 200 : 503 })
}
