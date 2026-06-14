/**
 * Monthly Decision Memory confidence decay (Decision Memory — Phase 8)
 *
 * Schedule: 1st of month 09:00 UTC (vercel.json). Memories that haven't been
 * recalled in 60+ days lose 0.05 confidence each run; once confidence drops to
 * 0.2 or below the memory is marked `deprecated`. The recall RPC only returns
 * `status='active'` rows, so a deprecated memory stops surfacing but is fully
 * preserved for audit. Brand-new memories (created < 60 days ago and never
 * recalled) are left untouched.
 *
 * Read-modify-write per row: supabase-js can't do column arithmetic, and adding
 * a decay RPC would be DDL (R105 — migration-only). The batch is bounded so a
 * single run can't fan out unbounded. Auth: CRON_SECRET Bearer token.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"

const ENDPOINT = "/api/cron/memory-decay"
const DECAY_STEP = 0.05
const DEPRECATE_AT = 0.2
const BATCH = 500
const STALE_DAYS = 60

export async function GET(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("decision_memory")
      .select("id, confidence, last_recalled_at, created_at")
      .eq("status", "active")
      .order("updated_at", { ascending: true })
      .limit(BATCH)
    if (error) throw new Error(error.message)

    interface DecayRow {
      id: string
      confidence: number | null
      last_recalled_at: string | null
      created_at: string
    }
    const rows = (data ?? []) as DecayRow[]

    // Eligible = not recalled in STALE_DAYS+. The reference point is
    // last_recalled_at when present, else created_at (never-recalled memories
    // age from birth). This is also what protects brand-new memories.
    const eligible = rows.filter((r) => {
      const ref = r.last_recalled_at ?? r.created_at
      return typeof ref === "string" && ref < staleCutoff
    })

    let decayed = 0
    let deprecated = 0
    const nowIso = new Date().toISOString()
    for (const r of eligible) {
      const current = typeof r.confidence === "number" ? r.confidence : 0.8
      const next = Math.max(0, Math.round((current - DECAY_STEP) * 100) / 100)
      const update: Record<string, unknown> = { confidence: next, updated_at: nowIso }
      if (next <= DEPRECATE_AT) {
        update.status = "deprecated"
        deprecated++
      } else {
        decayed++
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any).from("decision_memory").update(update).eq("id", r.id)
    }

    const result = { scanned: rows.length, eligible: eligible.length, decayed, deprecated }
    logCron({ endpoint: ENDPOINT, status: "success", duration_ms: Date.now() - start, details: result })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - start, error_message: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
