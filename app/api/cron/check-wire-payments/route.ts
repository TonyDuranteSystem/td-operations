/**
 * Cron: Check Wire Payments
 * Schedule: every 6 hours via Vercel cron
 *
 * Three detection methods:
 * 1. QuickBooks bank deposits (USD — Relay)
 * 2. Gmail Airwallex notifications (EUR — Airwallex IBAN)
 * 3. td_bank_feeds unmatched records (from bank webhooks)
 *
 * Matches against:
 * A. CRM invoices (payments where invoice_status IN ('Sent', 'Overdue'))
 * B. Pending activations (pending_activations where status = 'awaiting_payment')
 *
 * Match logic: compare amounts (±5% tolerance) + client name/reference in memo.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { qbApiCall } from "@/lib/quickbooks"
import { matchAndReconcile } from "@/lib/bank-feed-matcher"
import { syncAirwallexDeposits } from "@/lib/airwallex-sync"

export async function GET(req: NextRequest) {
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

    const { data: pendingList, error: pErr } = await supabase
      .from("pending_activations")
      .select("*")
      .eq("status", "awaiting_payment")
      .eq("payment_method", "bank_transfer")

    if (pErr) {
      console.error("[check-wire] Failed to query pending_activations:", pErr.message)
      await supabase.from("cron_log").insert({ endpoint: "/api/cron/check-wire-payments", status: "error", error_message: pErr.message, executed_at: new Date().toISOString() })
      return NextResponse.json({ error: pErr.message }, { status: 500 })
    }

    // ─── Step 2: Get open CRM invoices ───────────────────────────────

    const { data: openInvoices } = await supabase
      .from("payments")
      .select("id, account_id, invoice_number, invoice_status, total, amount, amount_currency, description, accounts:account_id(company_name)")
      .in("invoice_status", ["Sent", "Overdue"])
      .or("is_test.is.null,is_test.eq.false")

    console.warn(`[check-wire] ${pendingList?.length ?? 0} pending activations, ${openInvoices?.length ?? 0} open invoices`)

    // ─── Step 3: Query QB for recent deposits (last 14 days) ─────────

    let deposits: Array<Record<string, unknown>> = []
    try {
      const query = encodeURIComponent(
        `SELECT * FROM Deposit WHERE TxnDate >= '${dateStr}' ORDERBY TxnDate DESC MAXRESULTS 100`
      )
      const result = await qbApiCall(`/query?query=${query}`)
      deposits = result.QueryResponse?.Deposit || []
    } catch (e) {
      console.error("[check-wire] QB deposit query failed:", e)
      // Try payments as fallback
      try {
        const payQuery = encodeURIComponent(
          `SELECT * FROM Payment WHERE TxnDate >= '${dateStr}' ORDERBY TxnDate DESC MAXRESULTS 100`
        )
        const payResult = await qbApiCall(`/query?query=${payQuery}`)
        deposits = payResult.QueryResponse?.Payment || []
      } catch (e2) {
        console.error("[check-wire] QB payment query also failed:", e2)
        // Alert Antonio
        try {
          const { gmailPost } = await import("@/lib/gmail")
          const alertBody = `QuickBooks API is unreachable. Wire payment matching is NOT running.\n\nError: ${e2 instanceof Error ? e2.message : String(e2)}\n\nAction: Re-authorize QB at /api/qb/refresh or check token status.`
          const rawEmail = [
            `From: Tony Durante LLC <support@tonydurante.us>`,
            `To: support@tonydurante.us`,
            `Subject: ⚠️ QB API Down — Wire Payment Cron Failed`,
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: base64",
            "",
            Buffer.from(alertBody).toString("base64"),
          ].join("\r\n")
          await gmailPost("/messages/send", { raw: Buffer.from(rawEmail).toString("base64url") })
        } catch { /* non-blocking */ }
      }
    }

    console.warn(`[check-wire] Found ${deposits.length} recent QB deposits/payments`)

    // ─── Step 4: Store QB deposits in td_bank_feeds (dedup by external_id) ───

    let newFeedCount = 0
    for (const deposit of deposits) {
      const externalId = `qb_${deposit.Id}`
      const amount = parseFloat(String(deposit.TotalAmt || deposit.TotalAmount || 0))
      if (amount <= 0) continue

      // Check if already stored
      const { data: existing } = await supabase
        .from("td_bank_feeds")
        .select("id")
        .eq("external_id", externalId)
        .limit(1)

      if (existing?.length) continue

      await supabase.from("td_bank_feeds").insert({
        source: "qb_deposit",
        external_id: externalId,
        transaction_date: (deposit.TxnDate as string) || new Date().toISOString().split("T")[0],
        amount,
        currency: "USD",
        sender_name: (deposit.CustomerRef as { name?: string })?.name || null,
        memo: String(deposit.PrivateNote || deposit.Memo || ""),
        raw_data: deposit,
        status: "unmatched",
      })
      newFeedCount++
    }

    // ─── Step 5: Sync Airwallex EUR deposits via API ──────────────────

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

    // ─── Step 7: Match QB deposits against pending activations (legacy) ───

    let activationMatched = 0
    if (pendingList && pendingList.length > 0) {
      for (const pending of pendingList) {
        if (!pending.amount) continue

        const pendingAmount = parseFloat(pending.amount)
        const clientNameLower = (pending.client_name || "").toLowerCase()
        const tokenLower = (pending.offer_token || "").toLowerCase()

        for (const deposit of deposits) {
          const depositAmount = parseFloat(String(deposit.TotalAmt || deposit.TotalAmount || 0))
          const memo = String(deposit.PrivateNote || deposit.Memo || "").toLowerCase()
          const txnDate = deposit.TxnDate as string

          const amountDiff = Math.abs(depositAmount - pendingAmount)
          const tolerance = pendingAmount * 0.05
          const amountMatch = amountDiff <= tolerance
          const nameMatch = clientNameLower && memo.includes(clientNameLower.split(" ")[0])
          const tokenMatch = tokenLower && memo.includes(tokenLower)
          const exactAmountMatch = amountDiff < 1

          if (exactAmountMatch || (amountMatch && (nameMatch || tokenMatch))) {
            console.warn(`[check-wire] MATCH: ${pending.client_name} — $${pendingAmount} ≈ QB $${depositAmount} (${txnDate})`)

            const { data: wireUpdated } = await supabase
              .from("pending_activations")
              .update({
                status: "payment_confirmed",
                payment_confirmed_at: new Date().toISOString(),
                qb_transaction_ref: String(deposit.Id || ""),
                notes: `Matched QB deposit $${depositAmount} on ${txnDate}`,
                updated_at: new Date().toISOString(),
              })
              .eq("id", pending.id)
              .eq("status", "awaiting_payment")
              .select("id, lead_id")

            if (!wireUpdated || wireUpdated.length === 0) break

            if (wireUpdated[0].lead_id) {
              await supabase
                .from("leads")
                .update({ status: "Converted", updated_at: new Date().toISOString() })
                .eq("id", wireUpdated[0].lead_id)
            }

            // If pending_activation has a portal_invoice_id (created at signing), mark it Paid
            const { data: actWithInv } = await supabase
              .from("pending_activations")
              .select("portal_invoice_id")
              .eq("id", pending.id)
              .single()

            if (actWithInv?.portal_invoice_id) {
              try {
                const { syncInvoiceStatus } = await import("@/lib/portal/unified-invoice")
                const today = new Date().toISOString().split("T")[0]
                await syncInvoiceStatus("invoice", actWithInv.portal_invoice_id, "Paid", today, depositAmount)
              } catch { /* non-blocking */ }
            }

            const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL}`
            try {
              await fetch(`${baseUrl}/api/workflows/activate-service`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${process.env.API_SECRET_TOKEN}`,
                },
                body: JSON.stringify({ pending_activation_id: pending.id }),
              })
            } catch (e) {
              console.error("[check-wire] Failed to trigger activation:", e)
            }

            activationMatched++
            break
          }
        }
      }
    }

    const totalMatched = invoiceMatched + activationMatched

    console.warn(`[check-wire] Done. Feeds: ${newFeedCount + airwallexFeedCount} new. Invoices matched: ${invoiceMatched}. Activations matched: ${activationMatched}.`)

    await supabase.from("cron_log").insert({
      endpoint: "/api/cron/check-wire-payments",
      status: "success",
      details: {
        pending_activations: pendingList?.length ?? 0,
        open_invoices: openInvoices?.length ?? 0,
        qb_deposits: deposits.length,
        new_feeds: newFeedCount,
        airwallex_feeds: airwallexFeedCount,
        unmatched_feeds: unmatchedFeeds?.length ?? 0,
        invoice_matched: invoiceMatched,
        activation_matched: activationMatched,
        match_details: matchResults.slice(0, 10),
      },
      executed_at: new Date().toISOString(),
    })

    return NextResponse.json({
      ok: true,
      version: "54107de-wise-stopword",
      total_feeds_in_table: allFeeds?.length ?? 0,
      new_feeds: newFeedCount + airwallexFeedCount,
      unmatched_feeds_found: unmatchedFeeds?.length ?? 0,
      invoice_matched: invoiceMatched,
      activation_matched: activationMatched,
      total_matched: totalMatched,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[check-wire] Error:", msg)
    await supabase.from("cron_log").insert({ endpoint: "/api/cron/check-wire-payments", status: "error", error_message: msg, executed_at: new Date().toISOString() }).then(() => {})
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
