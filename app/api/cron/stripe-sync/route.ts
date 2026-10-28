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
import { LABELLED_MAX_AGE_DAYS, retryMarketingReceipts, settleHandRecordedSales, watchUnsettledMarketingPayments } from "@/lib/finance/marketing-sale-settle"

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
    // The sync can fail (Stripe down, key missing) without stopping Finance from settling what is already in the Bank Feed, so it never throws past here.
    let result: Awaited<ReturnType<typeof syncStripeCharges>>
    try { result = await syncStripeCharges({ daysBack }) } catch (e) { result = { ok: false, synced: 0, skipped: 0, total: 0, error: e instanceof Error ? e.message : String(e) } }

    // Rocco's marketing payments that are waiting in the Bank Feed (the labels are inside the saved Stripe payment), from the last days only: a few per run, one at a
    // time, and no new one is started after 45 seconds (the function stops at 60), so a long run can never be cut off in the middle of an invoice and its email.
    const budgetMs = 45_000
    const recent = new Date(Date.now() - LABELLED_MAX_AGE_DAYS * 86_400_000).toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: waiting } = await (supabaseAdmin as any)
      .from("td_bank_feeds")
      .select("id")
      .eq("source", "stripe")
      .eq("status", "unmatched")
      .eq("raw_data->payment_intent->metadata->>payment_kind", "marketing_sale")
      .gte("transaction_date", recent)
      .order("transaction_date", { ascending: true })
      .limit(5)
    const marketing = { waiting: (waiting ?? []).length, matched: 0, failed: 0, handRecorded: { looked: 0, matched: 0, failed: 0 }, receiptsRetried: { looked: 0, sent: 0, gaveUp: 0 }, stuck: 0 }
    for (const row of (waiting ?? []) as Array<{ id: string }>) {
      if (Date.now() - startTime > budgetMs) break
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
    if (Date.now() - startTime < budgetMs) try { marketing.handRecorded = await settleHandRecordedSales() } catch (e) { console.error("[stripe-sync] hand-recorded marketing sales:", e instanceof Error ? e.message : String(e)) }
    // invoice emails that failed or were cut off: tried again a few times, then reported
    if (Date.now() - startTime < budgetMs) try { marketing.receiptsRetried = await retryMarketingReceipts() } catch (e) { console.error("[stripe-sync] marketing receipts retry:", e instanceof Error ? e.message : String(e)) }
    // the webhook no longer marks the sale paid, so Finance is the only road: a payment received long ago and still unsettled is reported
    try { marketing.stuck = (await watchUnsettledMarketingPayments()).stuck } catch (e) { console.error("[stripe-sync] marketing watchdog:", e instanceof Error ? e.message : String(e)) }

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
