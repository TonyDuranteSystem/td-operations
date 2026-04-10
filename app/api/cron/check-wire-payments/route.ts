/**
 * Cron: Check Wire Payments
 * Schedule: every 6 hours via Vercel cron
 *
 * Bank feed sources (synced by separate crons/APIs):
 * - Mercury API (every 15 min via /api/cron/mercury-sync)
 * - Plaid/Relay (every 6h via /api/cron/plaid-sync)
 * - Airwallex API (synced in Step 3 below)
 *
 * This cron:
 * 1. Syncs Airwallex EUR deposits to td_bank_feeds
 * 2. Runs matchAndReconcile() on all unmatched feeds (auto-matches invoices)
 * 3. Matches remaining pending_activations against unmatched feeds
 *
 * QB is downstream accounting only — not used for payment detection.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { matchAndReconcile } from "@/lib/bank-feed-matcher"
import { syncAirwallexDeposits } from "@/lib/airwallex-sync"
import { logCron } from "@/lib/cron-log"

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

    // ─── Step 1: Get pending wire transfer activations ───────────────

    // Match ALL awaiting_payment activations regardless of payment_method.
    // Clients often select 'stripe' at signing but pay via bank transfer.
    const { data: pendingList, error: pErr } = await supabase
      .from("pending_activations")
      .select("*")
      .eq("status", "awaiting_payment")

    if (pErr) {
      console.error("[check-wire] Failed to query pending_activations:", pErr.message)
      logCron({ endpoint: "/api/cron/check-wire-payments", status: "error", duration_ms: Date.now() - startTime, error_message: pErr.message })
      return NextResponse.json({ error: pErr.message }, { status: 500 })
    }

    // ─── Step 2: Get open CRM invoices ───────────────────────────────

    const { data: openInvoices } = await supabase
      .from("payments")
      .select("id, account_id, invoice_number, invoice_status, total, amount, amount_currency, description, accounts:account_id(company_name)")
      .in("invoice_status", ["Sent", "Overdue"])
      .or("is_test.is.null,is_test.eq.false")

    console.warn(`[check-wire] ${pendingList?.length ?? 0} pending activations, ${openInvoices?.length ?? 0} open invoices`)

    // ─── Step 3: Sync Airwallex EUR deposits via API ──────────────────

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

    // ─── Step 5b: Content-based dedup safety net ────────────────────
    // Catch duplicates that slip past external_id (e.g. same deposit from different sources)

    try {
      const { data: recentFeeds } = await supabase
        .from("td_bank_feeds")
        .select("id, source, amount, transaction_date, sender_name, created_at")
        .eq("status", "unmatched")
        .order("created_at", { ascending: false })
        .limit(200)

      if (recentFeeds && recentFeeds.length > 1) {
        const seen = new Set<string>()
        const dupeIds: string[] = []

        for (const feed of recentFeeds) {
          const key = `${feed.source}|${Number(feed.amount).toFixed(2)}|${feed.transaction_date}|${(feed.sender_name || "").toLowerCase().trim()}`
          if (seen.has(key)) {
            dupeIds.push(feed.id)
          } else {
            seen.add(key)
          }
        }

        if (dupeIds.length > 0) {
          await supabase
            .from("td_bank_feeds")
            .update({ status: "duplicate", updated_at: new Date().toISOString() })
            .in("id", dupeIds)
          console.warn(`[check-wire] Marked ${dupeIds.length} content-duplicate feeds`)
        }
      }
    } catch (dedupErr) {
      console.error("[check-wire] Content dedup failed:", dedupErr)
    }

    // ─── Step 6: Match all unmatched feeds against invoices ──────────

    // Fetch all feeds and filter in code (PostgREST .eq on text may return stale results)
    const { data: allFeeds } = await supabase
      .from("td_bank_feeds")
      .select("id, status")
      .order("created_at", { ascending: false })
      .limit(500)

    const unmatchedFeeds = (allFeeds || []).filter(f => f.status === "unmatched")

    let invoiceMatched = 0
    const matchResults: Array<{ feedId: string; matched: boolean; error?: string; confidence?: string }> = []
    for (const feed of unmatchedFeeds || []) {
      const result = await matchAndReconcile(feed.id)
      if (result.matched) invoiceMatched++
      matchResults.push({ feedId: feed.id, matched: result.matched, error: result.error, confidence: result.confidence })
    }

    // ─── Step 5: Match pending activations against td_bank_feeds ───
    // Covers all bank feed sources: Airwallex (EUR), Mercury (USD), Plaid/Relay (USD).
    let activationMatched = 0
    if (pendingList && pendingList.length > 0) {
      const stillPending = pendingList.filter(p => p.status === "awaiting_payment" && p.amount)
      if (stillPending.length > 0) {
        const { data: recentFeeds } = await supabase
          .from("td_bank_feeds")
          .select("id, amount, currency, sender_name, sender_reference, memo, transaction_date, source")
          .eq("status", "unmatched")
          .order("transaction_date", { ascending: false })
          .limit(200)

        for (const pending of stillPending) {
          const pendingAmount = parseFloat(pending.amount)
          const clientNameLower = (pending.client_name || "").toLowerCase()

          for (const feed of recentFeeds || []) {
            const feedAmount = parseFloat(String(feed.amount || 0))
            const feedText = `${feed.sender_name || ""} ${feed.sender_reference || ""} ${feed.memo || ""}`.toLowerCase()

            const amountDiff = Math.abs(feedAmount - pendingAmount)
            const exactAmount = amountDiff < 1
            const tolerance = pendingAmount * 0.05
            const amountMatch = amountDiff <= tolerance
            const nameMatch = clientNameLower && feedText.includes(clientNameLower.split(" ")[0])

            if (exactAmount || (amountMatch && nameMatch)) {
              console.warn(`[check-wire] BANK FEED MATCH: ${pending.client_name} — ${feed.source} ${feedAmount} (${feed.transaction_date})`)

              const { data: feedUpdated } = await supabase
                .from("pending_activations")
                .update({
                  status: "payment_confirmed",
                  payment_confirmed_at: new Date().toISOString(),
                  notes: `Matched ${feed.source} feed ${feedAmount} ${feed.currency || ""} on ${feed.transaction_date}`,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", pending.id)
                .eq("status", "awaiting_payment")
                .select("id, lead_id")

              if (!feedUpdated || feedUpdated.length === 0) continue

              // Mark bank feed as matched
              await supabase
                .from("td_bank_feeds")
                .update({ status: "matched", matched_by: "auto", updated_at: new Date().toISOString() })
                .eq("id", feed.id)

              if (feedUpdated[0].lead_id) {
                await supabase
                  .from("leads")
                  .update({ status: "Converted", updated_at: new Date().toISOString() })
                  .eq("id", feedUpdated[0].lead_id)
              }

              // Mark portal invoice as Paid if exists
              const { data: actWithInv } = await supabase
                .from("pending_activations")
                .select("portal_invoice_id")
                .eq("id", pending.id)
                .single()

              if (actWithInv?.portal_invoice_id) {
                try {
                  const { syncInvoiceStatus } = await import("@/lib/portal/unified-invoice")
                  const today = new Date().toISOString().split("T")[0]
                  await syncInvoiceStatus("invoice", actWithInv.portal_invoice_id, "Paid", today, feedAmount)
                } catch { /* non-blocking */ }
              }

              // Trigger activate-service
              const baseUrl2 = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL}`
              try {
                const activateRes = await fetch(`${baseUrl2}/api/workflows/activate-service`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.API_SECRET_TOKEN}`,
                  },
                  body: JSON.stringify({ pending_activation_id: pending.id }),
                })

                if (!activateRes.ok) {
                  const errBody = await activateRes.text().catch(() => "unknown")
                  console.error(`[check-wire] activate-service returned ${activateRes.status} for ${pending.client_name}: ${errBody}`)

                  // Mark activation as failed so it's visible in CRM
                  await supabase
                    .from("pending_activations")
                    .update({
                      status: "activation_failed",
                      notes: `${pending.notes || ""}\nActivation failed (HTTP ${activateRes.status}): ${errBody.slice(0, 200)}`,
                      updated_at: new Date().toISOString(),
                    })
                    .eq("id", pending.id)

                  // Create CRM task for manual review
                  await supabase.from("tasks").insert({
                    task_title: `[ACTIVATION FAILED] ${pending.client_name} — wire payment matched but activation failed`,
                    assigned_to: "Luca",
                    category: "Internal",
                    priority: "Urgent",
                    status: "To Do",
                    description: `Pending activation ${pending.id} matched bank feed but activate-service returned HTTP ${activateRes.status}. Offer: ${pending.offer_token}. Check Vercel logs and retry manually.`,
                  })
                }
              } catch (e) {
                console.error("[check-wire] Failed to trigger activation from bank feed:", e)

                // Mark activation as failed
                await supabase
                  .from("pending_activations")
                  .update({
                    status: "activation_failed",
                    notes: `${pending.notes || ""}\nActivation fetch failed: ${e instanceof Error ? e.message : String(e)}`,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", pending.id)

                // Create CRM task for manual review
                await supabase.from("tasks").insert({
                  task_title: `[ACTIVATION FAILED] ${pending.client_name} — wire payment matched but activation call failed`,
                  assigned_to: "Luca",
                  category: "Internal",
                  priority: "Urgent",
                  status: "To Do",
                  description: `Pending activation ${pending.id} matched bank feed but fetch to activate-service failed. Offer: ${pending.offer_token}. Error: ${e instanceof Error ? e.message : String(e)}`,
                })
              }

              activationMatched++
              break
            }
          }
        }
      }
    }

    const totalMatched = invoiceMatched + activationMatched

    console.warn(`[check-wire] Done. Airwallex: ${airwallexFeedCount} new. Invoices matched: ${invoiceMatched}. Activations matched: ${activationMatched}.`)

    logCron({
      endpoint: "/api/cron/check-wire-payments",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: {
        pending_activations: pendingList?.length ?? 0,
        open_invoices: openInvoices?.length ?? 0,
        airwallex_feeds: airwallexFeedCount,
        unmatched_feeds: unmatchedFeeds?.length ?? 0,
        invoice_matched: invoiceMatched,
        activation_matched: activationMatched,
        match_details: matchResults.slice(0, 10),
      },
    })

    return NextResponse.json({
      ok: true,
      total_feeds_in_table: allFeeds?.length ?? 0,
      new_airwallex_feeds: airwallexFeedCount,
      unmatched_feeds_found: unmatchedFeeds?.length ?? 0,
      invoice_matched: invoiceMatched,
      activation_matched: activationMatched,
      total_matched: totalMatched,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[check-wire] Error:", msg)
    logCron({ endpoint: "/api/cron/check-wire-payments", status: "error", duration_ms: Date.now() - startTime, error_message: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
