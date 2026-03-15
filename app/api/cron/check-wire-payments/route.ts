/**
 * Cron: Check Wire Payments
 * Schedule: every 6 hours via Vercel cron
 *
 * Checks QuickBooks bank deposits for pending wire transfers.
 * Matches deposits against pending_activations (status = awaiting_payment, payment_method = bank_transfer).
 * When a match is found → triggers activate-formation workflow.
 *
 * Match logic: compare QB deposit amounts with pending_activation amounts (±5% tolerance)
 * and check if deposit memo/description contains client name or offer reference.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { qbApiCall } from "@/lib/quickbooks"

export async function GET(req: NextRequest) {
  try {
    // Verify cron secret (Vercel sends this header)
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // 1. Get pending wire transfer activations
    const { data: pendingList, error: pErr } = await supabase
      .from("pending_activations")
      .select("*")
      .eq("status", "awaiting_payment")
      .eq("payment_method", "bank_transfer")

    if (pErr) {
      console.error("[check-wire] Failed to query pending_activations:", pErr.message)
      return NextResponse.json({ error: pErr.message }, { status: 500 })
    }

    if (!pendingList || pendingList.length === 0) {
      console.log("[check-wire] No pending wire transfers to check")
      return NextResponse.json({ ok: true, checked: 0, matched: 0 })
    }

    console.log(`[check-wire] Found ${pendingList.length} pending wire transfers to check`)

    // 2. Query QB for recent deposits (last 14 days)
    const fourteenDaysAgo = new Date()
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)
    const dateStr = fourteenDaysAgo.toISOString().split("T")[0]

    const query = encodeURIComponent(
      `SELECT * FROM Deposit WHERE TxnDate >= '${dateStr}' ORDERBY TxnDate DESC MAXRESULTS 100`
    )

    let deposits: Array<Record<string, unknown>> = []
    try {
      const result = await qbApiCall(`/query?query=${query}`)
      deposits = result.QueryResponse?.Deposit || []
    } catch (e) {
      console.error("[check-wire] QB query failed:", e)
      // Try payments as fallback
      const payQuery = encodeURIComponent(
        `SELECT * FROM Payment WHERE TxnDate >= '${dateStr}' ORDERBY TxnDate DESC MAXRESULTS 100`
      )
      try {
        const payResult = await qbApiCall(`/query?query=${payQuery}`)
        deposits = payResult.QueryResponse?.Payment || []
      } catch (e2) {
        console.error("[check-wire] QB payment query also failed:", e2)
        return NextResponse.json({ error: "QB API unavailable" }, { status: 503 })
      }
    }

    console.log(`[check-wire] Found ${deposits.length} recent QB deposits/payments`)

    // 3. Match deposits against pending activations
    let matched = 0

    for (const pending of pendingList) {
      if (!pending.amount) continue

      const pendingAmount = parseFloat(pending.amount)
      const clientNameLower = (pending.client_name || "").toLowerCase()
      const tokenLower = (pending.offer_token || "").toLowerCase()

      for (const deposit of deposits) {
        const depositAmount = parseFloat(String(deposit.TotalAmt || deposit.TotalAmount || 0))
        const memo = String(deposit.PrivateNote || deposit.Memo || "").toLowerCase()
        const txnDate = deposit.TxnDate as string

        // Amount match (±5% tolerance for wire fees)
        const amountDiff = Math.abs(depositAmount - pendingAmount)
        const tolerance = pendingAmount * 0.05
        const amountMatch = amountDiff <= tolerance

        // Name/reference match
        const nameMatch = clientNameLower && memo.includes(clientNameLower.split(" ")[0])
        const tokenMatch = tokenLower && memo.includes(tokenLower)
        const exactAmountMatch = amountDiff < 1 // within $1

        // Match if: exact amount OR (close amount + name/token in memo)
        if (exactAmountMatch || (amountMatch && (nameMatch || tokenMatch))) {
          console.log(`[check-wire] MATCH: ${pending.client_name} — $${pendingAmount} ≈ QB $${depositAmount} (${txnDate})`)

          // Update pending_activation
          await supabase
            .from("pending_activations")
            .update({
              status: "payment_confirmed",
              payment_confirmed_at: new Date().toISOString(),
              qb_transaction_ref: String(deposit.Id || ""),
              notes: `Matched QB deposit $${depositAmount} on ${txnDate}`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", pending.id)

          // Trigger activation
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL}`
          try {
            await fetch(`${baseUrl}/api/workflows/activate-formation`, {
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

          matched++
          break // Don't match same pending to multiple deposits
        }
      }
    }

    console.log(`[check-wire] Done. Checked: ${pendingList.length}, Matched: ${matched}`)

    return NextResponse.json({
      ok: true,
      checked: pendingList.length,
      matched,
      deposits_found: deposits.length,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[check-wire] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
