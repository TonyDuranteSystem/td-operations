/**
 * Webhook: Relay Bank — Incoming transaction notifications
 *
 * Relay sends webhooks when deposits/withdrawals hit the TD LLC USD account.
 * This endpoint:
 * 1. Verifies webhook signature (RELAY_WEBHOOK_SECRET)
 * 2. Stores transaction in td_bank_feeds
 * 3. Auto-matches against pending CRM invoices (Sent/Overdue)
 * 4. If matched → marks invoice as Paid + triggers QB sync
 *
 * Setup: In Relay dashboard → Settings → Webhooks
 *   URL: [VERCEL_INTERNAL_DOMAIN]/api/webhooks/relay
 *   Events: transaction.created
 *
 * ENV VARS NEEDED:
 *   RELAY_WEBHOOK_SECRET — provided by Relay when configuring the webhook
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { matchAndReconcile } from "@/lib/bank-feed-matcher"
import crypto from "crypto"
import type { Json } from "@/lib/database.types"

export async function POST(req: NextRequest) {
  try {
    const body = await req.text()
    const signature = req.headers.get("x-relay-signature") || req.headers.get("x-webhook-signature") || ""

    // Verify signature (when RELAY_WEBHOOK_SECRET is configured)
    const secret = process.env.RELAY_WEBHOOK_SECRET
    if (secret) {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex")
      if (signature !== expected && signature !== `sha256=${expected}`) {
        console.error("[relay-webhook] Invalid signature")
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
      }
    } else {
      // No secret configured yet — log warning but still process
      console.warn("[relay-webhook] RELAY_WEBHOOK_SECRET not set — skipping signature verification")
    }

    const payload = JSON.parse(body)
    const event = payload.event || payload.type || "unknown"

    // Only process incoming deposits
    if (event !== "transaction.created" && event !== "deposit" && event !== "unknown") {
      return NextResponse.json({ ok: true, skipped: event })
    }

    // Extract transaction data (adapt field names to actual Relay API format)
    const txn = payload.data || payload.transaction || payload
    const amount = parseFloat(String(txn.amount || 0))

    // Skip outgoing transactions (negative amounts)
    if (amount <= 0) {
      return NextResponse.json({ ok: true, skipped: "outgoing" })
    }

    // Store in td_bank_feeds
    const { data: feed, error: feedErr } = await supabaseAdmin
      .from("td_bank_feeds")
      .insert({
        source: "relay",
        external_id: txn.id || txn.transaction_id || null,
        transaction_date: txn.date || txn.created_at?.split("T")[0] || new Date().toISOString().split("T")[0],
        amount,
        currency: "USD",
        sender_name: txn.counterparty_name || txn.sender_name || txn.description || null,
        sender_reference: txn.reference || txn.memo || null,
        memo: txn.description || txn.memo || null,
        raw_data: payload,
        status: "unmatched",
      })
      .select("id")
      .single()

    if (feedErr) {
      console.error("[relay-webhook] Failed to store transaction:", feedErr.message)
      return NextResponse.json({ error: feedErr.message }, { status: 500 })
    }

    // Auto-match against CRM invoices
    const matchResult = await matchAndReconcile(feed.id)

    // Log
    await supabaseAdmin.from("action_log").insert({
      action_type: "relay_webhook",
      table_name: "td_bank_feeds",
      record_id: feed.id,
      summary: matchResult.matched
        ? `Relay deposit $${amount} auto-matched to invoice ${matchResult.invoiceNumber}`
        : `Relay deposit $${amount} stored (unmatched)`,
      details: { amount, sender: txn.counterparty_name, matchResult } as unknown as Json,
    })

    return NextResponse.json({
      ok: true,
      feed_id: feed.id,
      matched: matchResult.matched,
      invoice: matchResult.invoiceNumber,
    })
  } catch (err) {
    console.error("[relay-webhook] Error:", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
