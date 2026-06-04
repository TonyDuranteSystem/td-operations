/**
 * Hermes instance health monitor (Phase A).
 *
 * Reads the hermes_instances heartbeat registry and flips any instance whose
 * heartbeat has gone stale (and is not already 'offline') to 'offline', so the
 * status column reflects reality. A later phase can hang alerting/notification
 * off this signal; Phase A only detects + records.
 *
 * Auth: CRON_SECRET Bearer token — same scheme as /api/cron/hermes-bridge.
 * Schedule: vercel.json `*​/5 * * * *` (kept in sync with lib/cron-coverage.ts).
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import {
  STALE_HEARTBEAT_MS,
  selectStaleOnline,
  type HermesInstanceRow,
} from "@/lib/ai-agent/hermes-health"

const ENDPOINT = "/api/cron/hermes-health"

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  // Mirror /api/cron/hermes-bridge: if CRON_SECRET is unset (local dev without
  // secrets), allow only the empty-secret case; production always has it.
  if (!cronSecret) return authHeader === null || authHeader === "Bearer "
  return authHeader === `Bearer ${cronSecret}`
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // 1) Load every registered instance.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("hermes_instances")
      .select("instance_id, last_heartbeat, status")

    if (error) throw error

    const rows = (data ?? []) as HermesInstanceRow[]
    const now = Date.now()
    const stale = selectStaleOnline(rows, now, STALE_HEARTBEAT_MS)

    // 2) Flip stale, not-already-offline instances to 'offline'.
    const offlined: string[] = []
    for (const row of stale) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upErr } = await (supabaseAdmin as any)
        .from("hermes_instances")
        .update({ status: "offline", updated_at: new Date().toISOString() })
        .eq("instance_id", row.instance_id)
        .neq("status", "offline")
      if (!upErr) offlined.push(row.instance_id)
    }

    const duration_ms = Date.now() - start
    const result = {
      checked: rows.length,
      stale: stale.length,
      offlined: offlined.length,
      offlined_ids: offlined,
    }
    logCron({ endpoint: ENDPOINT, status: "success", duration_ms, details: result })
    return NextResponse.json({ ok: true, duration_ms, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const duration_ms = Date.now() - start
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms, error_message: message })
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handle(req)
}
export async function POST(req: NextRequest) {
  return handle(req)
}
