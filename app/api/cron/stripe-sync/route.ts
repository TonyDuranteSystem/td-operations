/**
 * Cron: Stripe Charge Sync
 * Schedule: daily via Vercel cron
 *
 * Syncs successful Stripe charges into td_bank_feeds for reconciliation.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { syncStripeCharges } from "@/lib/stripe-sync"

export async function GET(req: NextRequest) {
  try {
    // Verify cron secret (Vercel sends this header)
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const result = await syncStripeCharges({ daysBack: 90 })

    await supabaseAdmin.from("cron_log").insert({
      endpoint: "/api/cron/stripe-sync",
      status: result.ok ? "success" : "error",
      details: {
        synced: result.synced,
        skipped: result.skipped,
        total: result.total,
      },
      error_message: result.error || null,
      executed_at: new Date().toISOString(),
    })

    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[stripe-sync] Cron error:", msg)

    await supabaseAdmin
      .from("cron_log")
      .insert({
        endpoint: "/api/cron/stripe-sync",
        status: "error",
        error_message: msg,
        executed_at: new Date().toISOString(),
      })
      .then(() => null)

    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
