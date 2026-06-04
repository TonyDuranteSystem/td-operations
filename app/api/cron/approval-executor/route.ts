/**
 * Approval executor route — Hermes ↔ Claude bridge (Phase 2, Slice 2).
 *
 * Runs APPROVED actions from approval_queue. Thin auth wrapper; all logic lives
 * in lib/ai-agent/approval-executor.ts (unit-tested there).
 *
 * Modes (mirrors the Phase 1 hermes-bridge worker):
 *   - DIRECT (GET/POST + ?id=<uuid>): execute exactly that approved row. Fired
 *     awaited-but-3s-bounded by approval_decide(approve) for low latency.
 *   - SCAN (no ?id): cron safety net — recover stuck 'executing' rows (>10 min),
 *     execute approved rows a direct trigger missed, expire stale pending rows.
 *
 * Auth: CRON_SECRET Bearer (same key the cron scheduler + approval_decide use).
 * Kill switch: APPROVAL_RAIL_ENABLED must === 'true', else returns {disabled:true}
 * and executes nothing (proposals still queue via propose_action).
 *
 * Do NOT use @vercel/functions waitUntil here — it broke the hermes-bridge route
 * on Next 14.2 ("No response is returned from route handler"). The direct trigger
 * is awaited-but-3s-bounded on the caller side; the route runs to completion
 * server-side regardless of the client timeout. See docs/systems/agent-bridge.md.
 */

export const dynamic = "force-dynamic"
// Real actions (email send, Drive upload) plus crash-recovery over multiple rows
// can take a while; 300s ceiling matches the Phase 1 worker.
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { runApprovalExecutor } from "@/lib/ai-agent/approval-executor"
import { logCron } from "@/lib/cron-log"

const ENDPOINT = "/api/cron/approval-executor"

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  // If CRON_SECRET is unset (local dev without secrets), allow only the empty
  // case to avoid accidental execution; production always has it set.
  if (!cronSecret) return authHeader === null || authHeader === "Bearer "
  return authHeader === `Bearer ${cronSecret}`
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get("id")
  const mode = id ? "direct" : "scan"

  try {
    const result = await runApprovalExecutor({ id })
    const duration_ms = Date.now() - start

    if (result.disabled) {
      logCron({ endpoint: ENDPOINT, status: "success", duration_ms, details: { mode, disabled: true } })
      return NextResponse.json({ ok: true, disabled: true, mode, duration_ms })
    }

    logCron({ endpoint: ENDPOINT, status: "success", duration_ms, details: { mode, ...result } })
    return NextResponse.json({ ...result, mode, duration_ms })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const duration_ms = Date.now() - start
    logCron({
      endpoint: ENDPOINT,
      status: "error",
      duration_ms,
      error_message: message,
      details: { mode, id },
    })
    return NextResponse.json({ ok: false, mode, error: message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
