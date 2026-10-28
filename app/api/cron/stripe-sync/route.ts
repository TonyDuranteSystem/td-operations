/**
 * Cron: Stripe Charge Sync
 * Schedule: every 3 minutes with a short look-back (?days=3; a payment is already stored after its first run, so each run only has the newest to do). A full look-back by hand: ?days=90.
 *
 * Syncs successful Stripe charges into td_bank_feeds for reconciliation (Antonio, 2026-10-28: Finance regulates, so Finance must see a payment within minutes, not
 * hours). Right after the sync, every payment from one of Rocco's TD Marketing links that is still unmatched is settled by Finance
 * (lib/finance/marketing-sale-settle.ts): invoice + credit, the sale paid, the lead's card moved, the invoice emailed once.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { syncStripeCharges } from "@/lib/stripe-sync"
import { logCron } from "@/lib/cron-log"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { processOneFeed } from "@/lib/operations/process-bank-feed-matches"
import { settleHandRecordedSales } from "@/lib/finance/marketing-sale-settle"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    // Verify cron secret (Vercel sends this header)
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const requested = parseInt(req.nextUrl.searchParams.get("days") ?? "3", 10)
    const daysBack = Number.isFinite(requested) && requested >= 1 && requested <= 90 ? requested : 3
    const result = await syncStripeCharges({ daysBack })

    // Rocco's marketing payments that are waiting in the Bank Feed (the labels are inside the saved Stripe payment). One at a time: each is safe to run twice.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: waiting } = await (supabaseAdmin as any)
      .from("td_bank_feeds")
      .select("id")
      .eq("source", "stripe")
      .eq("status", "unmatched")
      .eq("raw_data->payment_intent->metadata->>payment_kind", "marketing_sale")
      .order("transaction_date", { ascending: true })
      .limit(20)
    const marketing = { waiting: (waiting ?? []).length, matched: 0, failed: 0, handRecorded: { looked: 0, matched: 0, failed: 0 } }
    for (const row of (waiting ?? []) as Array<{ id: string }>) {
      try {
        const o = await processOneFeed(row.id)
        if (o.matched) marketing.matched++
        else marketing.failed++
      } catch (e) {
        marketing.failed++
        console.error("[stripe-sync] marketing payment could not be settled:", e instanceof Error ? e.message : String(e))
      }
    }

    // sales a person recorded by hand afterwards (no labels on the payment): the same settlement, found by the payment's Stripe id
    try { marketing.handRecorded = await settleHandRecordedSales() } catch (e) { console.error("[stripe-sync] hand-recorded marketing sales:", e instanceof Error ? e.message : String(e)) }

    logCron({
      endpoint: "/api/cron/stripe-sync",
      status: result.ok ? "success" : "error",
      duration_ms: Date.now() - startTime,
      details: { synced: result.synced, skipped: result.skipped, total: result.total, days: daysBack, marketing },
      error_message: result.error || undefined,
    })

    return NextResponse.json({ ...result, marketing })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[stripe-sync] Cron error:", msg)

    logCron({
      endpoint: "/api/cron/stripe-sync",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: msg,
    })

    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
