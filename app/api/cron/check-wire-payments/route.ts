/**
 * Cron: Check Wire Payments
 * Schedule: every 6 hours via Vercel cron
 *
 * Bank feed sources (synced by separate crons/APIs):
 * - Mercury API (every 15 min via /api/cron/mercury-sync — also runs matcher)
 * - Plaid/Relay (every 6h via /api/cron/plaid-sync)
 * - Airwallex API (synced in Step 3 below)
 *
 * This cron:
 * 1. Logs pending awaiting_payment activations + open invoices for observability
 * 2. Syncs Airwallex EUR deposits to td_bank_feeds (inline — keeps its own
 *    retry/error handling)
 * 3. Runs content-dedup safety net
 * 4. Routes TD's own money (payouts, rewards, spending) to My Finances — anything
 *    that is not provably a client paying an invoice. Wording-based marking was
 *    REMOVED 2026-07-27; the decision is evidence-based now.
 * 5. Delegates to processBankFeedMatches() — the canonical match + activation
 *    chain. Same lib used by the Mercury / Airwallex crons and the admin
 *    "Sync All Banks Now" button. NO hand-rolled match loop here.
 * 6. Runs the code↔production database contract monitor (see lib/db-contract-monitor.ts).
 *    It lives in THIS cron, not one of its own, because a standalone cron can be
 *    quietly unscheduled — and one in this repo already was. A guard that runs
 *    inside reconciliation cannot be switched off without switching off payments.
 *
 * QB is downstream accounting only — not used for payment detection.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { syncAirwallexDeposits } from "@/lib/airwallex-sync"
import { logCron } from "@/lib/cron-log"
import { processBankFeedMatches } from "@/lib/operations/process-bank-feed-matches"
import { sweepFeedsToOwnerLedger } from "@/lib/finance/owner-ledger-projection"
import { syncStripePayouts } from "@/lib/finance/stripe-payouts"
import { runContractMonitor } from "@/lib/db-contract-monitor"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    // Verify cron secret (Vercel sends this header)
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const fourteenDaysAgo = new Date()
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)
    const dateStr = fourteenDaysAgo.toISOString().split("T")[0]

    // ─── Step 1: Observability — log pending counts ──────────────────

    // Match ALL awaiting_payment activations regardless of payment_method.
    // Clients often select 'stripe' at signing but pay via bank transfer.
    const { data: pendingList, error: pErr } = await supabase
      .from("pending_activations")
      .select("id, status")
      .eq("status", "awaiting_payment")

    if (pErr) {
      console.error("[check-wire] Failed to query pending_activations:", pErr.message)
      logCron({ endpoint: "/api/cron/check-wire-payments", status: "error", duration_ms: Date.now() - startTime, error_message: pErr.message })
      return NextResponse.json({ error: pErr.message }, { status: 500 })
    }

    const { data: openInvoices } = await supabase
      .from("payments")
      .select("id")
      .in("invoice_status", ["Sent", "Overdue"])
      .or("is_test.is.null,is_test.eq.false")

    console.warn(`[check-wire] ${pendingList?.length ?? 0} pending activations, ${openInvoices?.length ?? 0} open invoices`)

    // ─── Step 2: Sync Airwallex EUR deposits via API ──────────────────
    // Kept inline — has its own retry / error handling we don't want to lose.

    let airwallexFeedCount = 0
    try {
      const toDate = new Date().toISOString().split("T")[0]
      const airwallexResult = await syncAirwallexDeposits(dateStr, toDate)
      airwallexFeedCount = airwallexResult.added
      if (airwallexResult.errors > 0) {
        console.error(`[check-wire] Airwallex sync had ${airwallexResult.errors} errors`)
      }
    } catch (airwallexErr) {
      console.error("[check-wire] Airwallex API sync failed:", airwallexErr)
    }

    // ─── Step 3: (REMOVED 2026-07-14) Content-based dedup safety net ──────
    //
    // This block used to flag a feed as `duplicate` when it shared
    // source + amount + transaction_date + sender_name with another unmatched row.
    // It was DELETING REAL MONEY from the review queue.
    //
    // `transaction_date` is a DATE, not a timestamp. So a client who legitimately
    // pays two invoices of the same amount on the same day with the same card
    // produces two rows that are identical on all four fields — and the second one
    // was silently marked `duplicate`. That is exactly what happened to Simple
    // Holdings USA on 2026-07-14: two genuine $50 Stripe charges (two different
    // invoices, two different Stripe charge ids, two different payment intents) and
    // the second payment vanished from the queue. `duplicate` has no filter tab in
    // the UI, so it rendered as "ignored" and nobody could see it.
    //
    // Real duplicates are already impossible: every sync path upserts on
    // `external_id` (the provider's own transaction id) with a unique conflict
    // target, so the same transaction can never be inserted twice. Content
    // similarity is NOT evidence of duplication — it is evidence of a client paying
    // two invoices. There is no dedup step here any more, by design.
    //
    // If a future feed source is ever found to emit the SAME deposit twice under
    // two different external_ids, dedup it on the provider's transaction id — never
    // on amount + name + day.

    // ─── Step 4: REMOVED 2026-07-27 — wording-based payout marking ──
    // This step read the bank's memo text for the literal "STRIPE; TRANSFER" and flipped the
    // row to `outgoing`. Antonio rejected deciding what money is from how a bank happens to
    // word it: the wording differs per bank, breaks the day payouts move accounts, and this
    // check had already missed every Relay payout (they read "STRIPE - TRANSFER", dash, in a
    // different field). Step 4b below now decides by EVIDENCE — a deposit stays in Finance
    // only if something proves a client is paying an invoice — so this step is not just
    // redundant, it contradicted the rule.

    // ─── Step 4a: Refresh the real Stripe payout list ───────────────
    // Stripe itself knows every payout's exact amount and arrival date. Keeping that list
    // current is what lets a "Stripe transfer" deposit be confirmed against a REAL payout
    // instead of trusting the wording a particular bank happens to print — the wording is
    // per-bank and would break the day payouts move to a different account. Runs before the
    // sweep so the list is fresh when it is consulted. Fire-and-forget.
    let payoutSync: Awaited<ReturnType<typeof syncStripePayouts>> | { error: string } | null = null
    try {
      payoutSync = await syncStripePayouts()
      if (!payoutSync.ok) console.error("[check-wire] Stripe payout sync failed:", payoutSync.error)
    } catch (payoutErr) {
      const msg = payoutErr instanceof Error ? payoutErr.message : String(payoutErr)
      console.error("[check-wire] Stripe payout sync threw:", msg)
      payoutSync = { error: msg }
    }

    // ─── Step 4b: Route TD's OWN money to My Finances ───────────────
    // Finance holds ONLY client invoice payments (Antonio, 2026-07-27). Everything else —
    // Stripe payouts, bank rewards, money TD spent — is copied into My Finances and taken
    // out of the Bank Feed. This runs BEFORE the matcher on purpose: a payout that never
    // reaches Step 5 can never be scored against a client invoice, which is the double-count
    // this exists to prevent. Fire-and-forget: a failure here must not stop reconciliation.
    let ownerLedger: Awaited<ReturnType<typeof sweepFeedsToOwnerLedger>> | { error: string } | null = null
    try {
      ownerLedger = await sweepFeedsToOwnerLedger()
      if (ownerLedger.ok && (ownerLedger.marked ?? 0) > 0) {
        console.warn(`[check-wire] Routed ${ownerLedger.marked} transaction(s) to My Finances`)
      } else if (!ownerLedger.ok) {
        console.error("[check-wire] owner-ledger sweep failed:", ownerLedger.error)
      }
    } catch (sweepErr) {
      const msg = sweepErr instanceof Error ? sweepErr.message : String(sweepErr)
      console.error("[check-wire] owner-ledger sweep threw:", msg)
      ownerLedger = { error: msg }
    }

    // ─── Step 5: Auto-match + auto-activate via shared orchestrator ─
    // Replaces the prior hand-rolled match loop. processBankFeedMatches:
    //   - calls matchAndReconcile on every unmatched feed (limit 200)
    //   - runs runActivation on any linked pending_activation when matched
    //   - parks crashed activations at status='activation_crashed' for retry
    //   - holds medium-confidence rows at status='needs_review' (Antonio's
    //     locked policy: auto-activate ONLY on exact match).
    let matchResult: Awaited<ReturnType<typeof processBankFeedMatches>> | { error: string } | null = null
    try {
      matchResult = await processBankFeedMatches()
    } catch (matchErr) {
      const msg = matchErr instanceof Error ? matchErr.message : String(matchErr)
      console.error("[check-wire] processBankFeedMatches failed:", msg)
      matchResult = { error: msg }
    }

    // ─── Step 6: Code ↔ PRODUCTION database contract ────────────────
    //
    // Asks the live database whether it still accepts every value this deployed code can write,
    // and whether it still matches the snapshot the push-time gate checks against.
    //
    // WHY IT LIVES HERE, INSIDE RECONCILIATION, AND NOT IN A CRON OF ITS OWN:
    // a standalone cron can be quietly unscheduled, and this repo has the precedent (the
    // error-auto-audit loop is switched off). A check that runs inside the payments run cannot
    // be switched off without switching off payments. The point of a guard is that it is still
    // there on the day nobody remembers why it was added.
    //
    // Silent failure is what this exists to catch, so it must never fail silently itself:
    // runContractMonitor raises a dev-board job AND a system_errors row, and its own crash is
    // reported into the cron log rather than swallowed.
    let contractResult: Awaited<ReturnType<typeof runContractMonitor>> | { error: string } | null = null
    try {
      contractResult = await runContractMonitor()
    } catch (contractErr) {
      const msg = contractErr instanceof Error ? contractErr.message : String(contractErr)
      console.error("[check-wire] contract monitor failed:", msg)
      contractResult = { error: msg }
    }

    console.warn(`[check-wire] Done. Airwallex: ${airwallexFeedCount} new. Match:`, matchResult)

    logCron({
      endpoint: "/api/cron/check-wire-payments",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: {
        pending_activations: pendingList?.length ?? 0,
        open_invoices: openInvoices?.length ?? 0,
        airwallex_feeds: airwallexFeedCount,
        stripe_payout_sync: payoutSync,
        owner_ledger: ownerLedger,
        match: matchResult,
        db_contract: contractResult,
      },
    })

    return NextResponse.json({
      ok: true,
      pending_activations: pendingList?.length ?? 0,
      new_airwallex_feeds: airwallexFeedCount,
      stripe_payout_sync: payoutSync,
      owner_ledger: ownerLedger,
      match: matchResult,
      db_contract: contractResult,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[check-wire] Error:", msg)
    logCron({ endpoint: "/api/cron/check-wire-payments", status: "error", duration_ms: Date.now() - startTime, error_message: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
