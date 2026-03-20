/**
 * Cron: Check Wire Payments
 * Schedule: every 6 hours via Vercel cron
 *
 * Two detection methods:
 * 1. QuickBooks bank deposits (USD — Relay)
 * 2. Gmail Airwallex notifications (EUR — Airwallex IBAN)
 *
 * Matches against pending_activations (status = awaiting_payment, payment_method = bank_transfer).
 * When a match is found → triggers activate-service workflow.
 *
 * Match logic: compare amounts (±5% tolerance) + client name/reference in memo.
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
      await supabase.from("cron_log").insert({ endpoint: "/api/cron/check-wire-payments", status: "error", error_message: pErr.message, executed_at: new Date().toISOString() })
      return NextResponse.json({ error: pErr.message }, { status: 500 })
    }

    if (!pendingList || pendingList.length === 0) {
      console.log("[check-wire] No pending wire transfers to check")
      await supabase.from("cron_log").insert({ endpoint: "/api/cron/check-wire-payments", status: "success", details: { checked: 0, matched: 0, message: "No pending wire transfers" }, executed_at: new Date().toISOString() })
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
        // Alert Antonio that QB is unreachable
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
        } catch (emailErr) {
          console.error("[check-wire] Failed to send QB alert email:", emailErr)
        }
        await supabase.from("cron_log").insert({ endpoint: "/api/cron/check-wire-payments", status: "error", error_message: "QB API unavailable", executed_at: new Date().toISOString() })
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

          // Optimistic locking: only update if still awaiting_payment (prevents race with Whop webhook)
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

          if (!wireUpdated || wireUpdated.length === 0) {
            console.log(`[check-wire] pending_activation ${pending.id} already processed — skipping`)
            break
          }

          // Lead → Converted at payment
          if (wireUpdated[0].lead_id) {
            await supabase
              .from("leads")
              .update({ status: "Converted", updated_at: new Date().toISOString() })
              .eq("id", wireUpdated[0].lead_id)
          }

          // Trigger activation
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

          matched++
          break // Don't match same pending to multiple deposits
        }
      }
    }

    // 4. Check Airwallex EUR deposits via Gmail (for EUR pending activations not yet matched)
    const eurPending = pendingList.filter(p =>
      p.status === "awaiting_payment" &&
      (p.currency === "EUR" || p.currency === "eur")
    )

    // Also re-check: some may have been matched by QB above, reload
    let airwallexMatched = 0
    if (eurPending.length > 0) {
      try {
        const { gmailGet } = await import("@/lib/gmail")

        // Search for Airwallex deposit notifications in the last 14 days
        const searchQuery = encodeURIComponent(`from:airwallex subject:"deposit" after:${dateStr.replace(/-/g, "/")}`)
        const searchResult = await gmailGet(`/messages?q=${searchQuery}&maxResults=50`)
        const messageIds = (searchResult.messages || []) as Array<{ id: string }>

        // Parse each Airwallex email for amount and sender
        const airwallexDeposits: Array<{ amount: number; sender: string; date: string; messageId: string }> = []

        for (const msg of messageIds.slice(0, 20)) {
          try {
            const detail = await gmailGet(`/messages/${msg.id}?format=full`)
            const headers = (detail.payload?.headers || []) as Array<{ name: string; value: string }>
            const dateHeader = headers.find((h: { name: string }) => h.name === "Date")?.value || ""
            const snippet = String(detail.snippet || "")

            // Parse amount from snippet: "deposit of 3,000.00 EUR" or "deposit of 3000.00 EUR"
            const amountMatch = snippet.match(/deposit\s+of\s+([\d,.]+)\s*EUR/i)
            // Parse sender: "from ATCOACHING LLC" or "from Company Name"
            const senderMatch = snippet.match(/from\s+([A-Z][A-Za-z0-9\s.]+(?:LLC|Inc|Ltd|Corp)?)/i)

            if (amountMatch) {
              const amount = parseFloat(amountMatch[1].replace(/,/g, ""))
              const sender = senderMatch ? senderMatch[1].trim() : ""
              airwallexDeposits.push({ amount, sender, date: dateHeader, messageId: msg.id })
            }
          } catch {
            // Skip individual email parse errors
          }
        }

        console.log(`[check-wire] Found ${airwallexDeposits.length} Airwallex EUR deposits`)

        // Match EUR pending activations against Airwallex deposits
        for (const pending of eurPending) {
          // Re-check status (may have been matched by QB above)
          const { data: currentStatus } = await supabase
            .from("pending_activations")
            .select("status")
            .eq("id", pending.id)
            .single()

          if (currentStatus?.status !== "awaiting_payment") continue

          const pendingAmount = parseFloat(pending.amount)
          const clientNameLower = (pending.client_name || "").toLowerCase()

          for (const deposit of airwallexDeposits) {
            const amountDiff = Math.abs(deposit.amount - pendingAmount)
            const exactMatch = amountDiff < 1
            const toleranceMatch = amountDiff <= pendingAmount * 0.05
            const senderLower = deposit.sender.toLowerCase()

            // Match: exact amount OR (close amount + sender contains client name)
            const nameWords = clientNameLower.split(/\s+/).filter(w => w.length > 2)
            const nameMatch = nameWords.some(w => senderLower.includes(w))

            if (exactMatch || (toleranceMatch && nameMatch)) {
              console.log(`[check-wire] AIRWALLEX MATCH: ${pending.client_name} — EUR ${pendingAmount} = Airwallex EUR ${deposit.amount} from "${deposit.sender}"`)

              const { data: wireUpdated } = await supabase
                .from("pending_activations")
                .update({
                  status: "payment_confirmed",
                  payment_confirmed_at: new Date().toISOString(),
                  qb_transaction_ref: `airwallex:${deposit.messageId}`,
                  notes: `Matched Airwallex EUR deposit: ${deposit.amount} EUR from "${deposit.sender}" on ${deposit.date}`,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", pending.id)
                .eq("status", "awaiting_payment")
                .select("id, lead_id")

              if (!wireUpdated || wireUpdated.length === 0) continue

              // Lead → Converted
              if (wireUpdated[0].lead_id) {
                await supabase
                  .from("leads")
                  .update({ status: "Converted", updated_at: new Date().toISOString() })
                  .eq("id", wireUpdated[0].lead_id)
              }

              // Trigger activation
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
                console.error("[check-wire] Failed to trigger activation for Airwallex match:", e)
              }

              airwallexMatched++
              matched++
              break
            }
          }
        }
      } catch (airwallexErr) {
        console.error("[check-wire] Airwallex Gmail check failed:", airwallexErr)
        // Non-blocking: QB matching still works
      }
    }

    console.log(`[check-wire] Done. Checked: ${pendingList.length}, Matched: ${matched} (QB: ${matched - airwallexMatched}, Airwallex: ${airwallexMatched})`)

    await supabase.from("cron_log").insert({ endpoint: "/api/cron/check-wire-payments", status: "success", details: { checked: pendingList.length, matched, airwallex_matched: airwallexMatched, deposits_found: deposits.length }, executed_at: new Date().toISOString() })

    return NextResponse.json({
      ok: true,
      checked: pendingList.length,
      matched,
      deposits_found: deposits.length,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[check-wire] Error:", msg)
    await supabase.from("cron_log").insert({ endpoint: "/api/cron/check-wire-payments", status: "error", error_message: msg, executed_at: new Date().toISOString() }).then(() => {})
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
