/**
 * Webhook: Banking Circle — Incoming EUR payment notifications
 *
 * Banking Circle sends webhooks when payments arrive on the TD LLC EUR IBAN.
 * This endpoint:
 * 1. Verifies webhook signature (BC_WEBHOOK_SECRET)
 * 2. Stores transaction in td_bank_feeds
 * 3. Auto-matches against pending CRM invoices (Sent/Overdue)
 * 4. If matched → marks invoice as Paid + triggers QB sync
 *
 * Setup: Via Banking Circle API or account manager
 *   URL: [VERCEL_INTERNAL_DOMAIN]/api/webhooks/banking-circle
 *   Events: payment.received
 *
 * ENV VARS NEEDED:
 *   BC_WEBHOOK_SECRET — provided by Banking Circle
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { matchAndReconcile } from "@/lib/bank-feed-matcher"
import crypto from "crypto"

export async function POST(req: NextRequest) {
  try {
    const body = await req.text()
    const signature = req.headers.get("x-bc-signature") || req.headers.get("x-webhook-signature") || ""

    // Verify signature
    const secret = process.env.BC_WEBHOOK_SECRET
    if (secret) {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex")
      if (signature !== expected && signature !== `sha256=${expected}`) {
        console.error("[bc-webhook] Invalid signature")
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
      }
    } else {
      console.warn("[bc-webhook] BC_WEBHOOK_SECRET not set — skipping signature verification")
    }

    const payload = JSON.parse(body)
    const event = payload.event || payload.type || "unknown"

    // Only process incoming payments
    if (event !== "payment.received" && event !== "unknown") {
      return NextResponse.json({ ok: true, skipped: event })
    }

    const txn = payload.data || payload.payment || payload
    const amount = parseFloat(String(txn.amount || txn.instructedAmount || 0))

    if (amount <= 0) {
      return NextResponse.json({ ok: true, skipped: "outgoing" })
    }

    // Store in td_bank_feeds
    const { data: feed, error: feedErr } = await supabaseAdmin
      .from("td_bank_feeds")
      .insert({
        source: "banking_circle",
        external_id: txn.paymentId || txn.transactionId || txn.id || null,
        transaction_date: txn.valueDate || txn.bookingDate || new Date().toISOString().split("T")[0],
        amount,
        currency: txn.currency || "EUR",
        sender_name: txn.debtorName || txn.senderName || null,
        sender_reference: txn.endToEndId || txn.remittanceInfo || txn.reference || null,
        memo: txn.remittanceInfo || txn.additionalInfo || null,
        raw_data: payload,
        status: "unmatched",
      })
      .select("id")
      .single()

    if (feedErr) {
      console.error("[bc-webhook] Failed to store transaction:", feedErr.message)
      return NextResponse.json({ error: feedErr.message }, { status: 500 })
    }

    // Auto-match
    const matchResult = await matchAndReconcile(feed.id)

    await supabaseAdmin.from("action_log").insert({
      action_type: "banking_circle_webhook",
      entity_type: "td_bank_feeds",
      entity_id: feed.id,
      summary: matchResult.matched
        ? `BC deposit €${amount} auto-matched to invoice ${matchResult.invoiceNumber}`
        : `BC deposit €${amount} stored (unmatched)`,
      details: { amount, currency: txn.currency, sender: txn.debtorName, matchResult },
    })

    return NextResponse.json({
      ok: true,
      feed_id: feed.id,
      matched: matchResult.matched,
      invoice: matchResult.invoiceNumber,
    })
  } catch (err) {
    console.error("[bc-webhook] Error:", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
